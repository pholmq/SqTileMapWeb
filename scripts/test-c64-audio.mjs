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
  prepareC64FrameEvents,
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

// 1. Border-only / idle writes must produce no toggles
{
  const state = createSidSynthState();
  const border = new Uint32Array([(938 << 8) | 0x00]);
  assert.equal(prepareC64FrameEvents(border, state).toggles.length, 0);

  const stray = makeEvents([33759], 5000, false);
  assert.equal(prepareC64FrameEvents(stray, state).toggles.length, 0);
}

// 2. 50 Hz CPU-busy gap between consecutive active frames must be bridged seamlessly
{
  const state = createSidSynthState();
  const f1 = makeEvents(Array(20).fill(1227), 44000, false);
  const p1 = prepareC64FrameEvents(f1, state);
  assert.equal(p1.endsNearBoundary, true);

  // Next frame starts after ~43k cycle CPU draw gap with a close half-period (1367)
  const f2 = makeEvents(Array(19).fill(1367), 43000, false);
  const p2 = prepareC64FrameEvents(f2, state);
  assert.ok(p2.toggles.length > 40, `expected bridged toggles across CPU gap, got ${p2.toggles.length}`);
  assert.ok(p2.toggles[0].cycle < 2000, `expected gap fill starting near cycle 0, got ${p2.toggles[0].cycle}`);
}

// 3. Short isolated burst stays short (not stretched across whole frame)
{
  const state = createSidSynthState();
  const footstep = makeEvents([881, 1196, 1151, 1106], 34378, false);
  const p = prepareC64FrameEvents(footstep, state);
  assert.equal(p.isShortBurst, true);

  const buf = new Float32Array(960);
  synthesizeC64Frame(state, p, 48000, buf);
  // First 8ms (384 samples) before 34378 cycles (~9.8ms) should be silent
  const preRms = Math.sqrt(buf.slice(0, 380).reduce((a, b) => a + b * b, 0) / 380);
  assert.ok(preRms < 0.0001, `expected silence before blip onset, got preRms=${preRms}`);
  const activePeak = Math.max(...Array.from(buf.slice(460, 620), Math.abs));
  assert.ok(activePeak > 0.02, `expected active blip peak, got ${activePeak}`);
}

// 4. Chaotic intervals trigger SID LFSR noise texture
{
  const state = createSidSynthState();
  const noisy = makeEvents([310, 1420, 240, 1890, 410, 1120, 290, 1640, 350, 980, 260, 1510], 30000, false);
  const p = prepareC64FrameEvents(noisy, state);
  assert.equal(p.isNoise, true);
  assert.ok(p.noiseClockHz >= 450);
}

// 5. End-to-end integration on live Starquake WASM frames: check bounded peaks & smooth frame boundaries
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
  let activeFrames = 0;
  let maxPeak = 0;
  let prevLastSample = 0;
  let maxBoundaryJump = 0;

  for (let f = 1; f <= 80; f++) {
    if (f === 41) e.emu_set_key_row(7, 0xff & ~(1 << 2));
    if (f === 56) e.emu_set_key_row(7, 0xff);
    e.emu_begin_frame();
    e.emu_tick_range(0, 512, 50, f, 2, 0, 15, 0, 31);
    const count = Math.min(4096, e.emu_audio_count());
    const events = count ? new Uint32Array(mem.buffer, e.emu_audio_ptr() >>> 0, count).slice() : new Uint32Array(0);
    const prepared = prepareC64FrameEvents(events, state);
    if (prepared.toggles.length) activeFrames++;
    const out = new Float32Array(Math.round((sampleRate * prepared.totalCycles) / 3500000));
    synthesizeC64Frame(state, prepared, sampleRate, out);
    maxBoundaryJump = Math.max(maxBoundaryJump, Math.abs(out[0] - prevLastSample));
    prevLastSample = out[out.length - 1];
    for (const s of out) {
      assert.ok(Number.isFinite(s));
      maxPeak = Math.max(maxPeak, Math.abs(s));
    }
  }
  assert.ok(activeFrames >= 10, `expected active Starquake frames, got ${activeFrames}`);
  assert.ok(maxPeak > 0.05 && maxPeak <= 0.95, `unexpected peak ${maxPeak}`);
  assert.ok(maxBoundaryJump < 0.25, `unexpected frame-boundary discontinuity ${maxBoundaryJump}`);

  // Legacy spectrum renderer sanity check
  const bufSpec = new Float32Array(960);
  renderSpectrumBeeperFrame(createSidSynthState(), makeEvents([1227, 1227, 1227, 1227]), 0, sampleRate, bufSpec);
  assert.ok(bufSpec.some(v => Math.abs(v) > 0.001));
}

console.log('C64 SID audio analysis & synthesis tests passed.');
