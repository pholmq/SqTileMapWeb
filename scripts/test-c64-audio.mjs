import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsSource = fs.readFileSync(path.join(root, 'src/c64Audio.ts'), 'utf8');
const { code } = transformSync(tsSource, { loader: 'ts', format: 'esm', target: 'es2022' });
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const {
  detectC64Triggers,
  createSidSynthState,
  synthesizeC64Frame,
  renderSpectrumBeeperFrame,
} = mod;

function makeEvents(intervals, startCycle = 1000, startBit = true) {
  const arr = [];
  let c = startCycle;
  let bit = startBit;
  arr.push((c << 8) | (bit ? 0x10 : 0x00));
  for (const dt of intervals) {
    c += dt;
    bit = !bit;
    arr.push((c << 8) | (bit ? 0x10 : 0x00));
  }
  return new Uint32Array(arr);
}

// 1. Border-only / idle writes trigger nothing
{
  const state = createSidSynthState();
  const border = new Uint32Array([(938 << 8) | 0x00]);
  assert.deepEqual(detectC64Triggers(border, undefined, state), []);

  const stray = makeEvents([33759], 5000, false);
  assert.deepEqual(detectC64Triggers(stray, undefined, state), []);
}

// 2. Multi-frame RAM SFX states trigger exact C64 presets
{
  const state = createSidSynthState();
  // Laser shot: rem=5, step=-9 (0xf7)
  const laserRam = new Uint8Array([0, 0, 5, 0xbf, 0xf7, 0xfb, 1, 1]);
  assert.deepEqual(detectC64Triggers(new Uint32Array(0), laserRam, state), ['laser']);

  // Holding same countdown does not retrigger mid-shot
  const laserFrame2 = new Uint8Array([0, 0, 4, 0xb6, 0xf7, 0xfc, 1, 1]);
  assert.deepEqual(detectC64Triggers(makeEvents(Array(15).fill(1367), 43000, false), laserFrame2, state), []);

  // Platform drop: rem=2, step=+10 (0x0a)
  const platRam = new Uint8Array([0, 0, 2, 0x82, 0x0a, 0x10, 1, 1]);
  assert.deepEqual(detectC64Triggers(new Uint32Array(0), platRam, state), ['platform']);

  // Big explosion: rem=63 (0x3f)
  const expRam = new Uint8Array([0, 0, 0x3f, 0x00, 0x00, 0x1a, 1, 1]);
  assert.deepEqual(detectC64Triggers(new Uint32Array(0), expRam, state), ['explosion_big']);
}

// 3. Immediate 0xD7C0 bursts classify footsteps, pickups, and noisy hits
{
  const state = createSidSynthState();
  const footstep = makeEvents([881, 1196, 1151, 1106], 34378, false);
  assert.deepEqual(detectC64Triggers(footstep, new Uint8Array(8), state), ['footstep']);

  const pickup = makeEvents([611, 566, 521, 476, 431, 386, 341, 296], 33000, false);
  assert.deepEqual(detectC64Triggers(pickup, new Uint8Array(8), state), ['pickup']);

  const hit = makeEvents([310, 1420, 240, 1890, 410, 1120, 290, 1640, 350, 980, 260, 1510, 390, 1200], 30000, false);
  assert.deepEqual(detectC64Triggers(hit, new Uint8Array(8), state), ['explosion_small']);
}

// 4. End-to-end synthesis on live Starquake WASM frames
{
  const wasmBytes = fs.readFileSync(path.join(root, 'public/z80-single.wasm'));
  const sna = fs.readFileSync(path.join(root, 'public/starquake.sna'));
  const rom = fs.readFileSync(path.join(root, 'public/48.rom'));
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const e = instance.exports;
  const mem = e.memory;
  const heapBase = (e.__heap_base?.value ?? e.__data_end?.value ?? 0) + 1024;
  const snaPtr = heapBase;
  const romPtr = snaPtr + sna.length + 16;
  const req = romPtr + rom.length + 16;
  if (req > mem.buffer.byteLength) mem.grow(Math.ceil((req - mem.buffer.byteLength) / 65536));
  const heap = new Uint8Array(mem.buffer);
  heap.set(sna, snaPtr);
  heap.set(rom, romPtr);
  assert.equal(e.emu_init(snaPtr, sna.length, romPtr, rom.length, 0), 0);

  const state = createSidSynthState();
  const sampleRate = 48000;
  let totalVoiceTriggers = 0;
  let maxPeak = 0;
  let prevLastSample = 0;
  let maxBoundaryJump = 0;

  for (let f = 1; f <= 120; f++) {
    if (f === 41) e.emu_set_key_row(7, 0xff & ~(1 << 2));
    if (f === 65) { e.emu_set_key_row(7, 0xff); e.emu_set_key_row(2, 0xff & ~1); }
    if (f === 90) { e.emu_set_key_row(2, 0xff); e.emu_set_key_row(1, 0xff & ~1); }
    e.emu_begin_frame();
    e.emu_tick_range(0, 512, 50, f, 2, 0, 15, 0, 31);
    const count = Math.min(4096, e.emu_audio_count());
    const events = count ? new Uint32Array(mem.buffer, e.emu_audio_ptr() >>> 0, count).slice() : new Uint32Array(0);
    const ptr = e.emu_screen_ptr(e.emu_current_room()) >>> 0;
    const sfxRam = new Uint8Array(mem.buffer, ptr + (0xa41b - 0x4000), 8).slice();

    const out = new Float32Array(960);
    const before = state.voices.length;
    synthesizeC64Frame(state, events, sfxRam, sampleRate, out);
    if (state.voices.length > before) totalVoiceTriggers++;

    maxBoundaryJump = Math.max(maxBoundaryJump, Math.abs(out[0] - prevLastSample));
    prevLastSample = out[out.length - 1];
    for (const s of out) {
      assert.ok(Number.isFinite(s));
      maxPeak = Math.max(maxPeak, Math.abs(s));
    }
  }
  assert.ok(totalVoiceTriggers >= 5, `expected multiple SID voice triggers, got ${totalVoiceTriggers}`);
  assert.ok(maxPeak > 0.05 && maxPeak <= 0.95, `unexpected peak ${maxPeak}`);
  assert.ok(maxBoundaryJump < 0.25, `unexpected boundary jump ${maxBoundaryJump}`);

  // Legacy spectrum renderer sanity check
  const bufSpec = new Float32Array(960);
  renderSpectrumBeeperFrame(createSidSynthState(), makeEvents([1227, 1227, 1227, 1227]), 0, sampleRate, bufSpec);
  assert.ok(bufSpec.some(v => Math.abs(v) > 0.001));
}

console.log('C64 SID audio analysis & synthesis tests passed.');
