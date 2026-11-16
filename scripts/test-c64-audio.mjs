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
  analyzeSpectrumFrame,
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

// 1. Border-only / idle writes must be silent
{
  const border = new Uint32Array([(938 << 8) | 0x00]);
  const res = analyzeSpectrumFrame(border, false);
  assert.equal(res.kind, 'silent');

  const stray = makeEvents([33759], 5000, false);
  const strayRes = analyzeSpectrumFrame(stray, false);
  assert.equal(strayRes.kind, 'silent');
}

// 2. 50Hz CPU-busy frame gap (0xA5BE pattern) must be stripped so true pitch is preserved
{
  const ev = makeEvents([8587, 1227, 1227, 1227, 1227, 1227, 1227, 1227], 1000, false);
  const res = analyzeSpectrumFrame(ev, false);
  assert.equal(res.kind, 'tone');
  const expectedHz = 3500000 / (2 * 1227);
  assert.ok(Math.abs(res.startFreq - expectedHz) < 5, `expected ~${expectedHz}, got ${res.startFreq}`);
  assert.ok(Math.abs(res.endFreq - expectedHz) < 5);
}

// 3. Monotonic upward pitch sweep must remain 'tone' with rising endFreq > startFreq
{
  const ev = makeEvents([611, 566, 521, 476, 431, 386, 341, 296], 32000, false);
  const res = analyzeSpectrumFrame(ev, false);
  assert.equal(res.kind, 'tone');
  assert.ok(res.endFreq > res.startFreq, `expected rising sweep, got ${res.startFreq} -> ${res.endFreq}`);

  const evMid = makeEvents([1400, 1250, 1100, 950, 800, 650, 550, 500], 32000, false);
  const resMid = analyzeSpectrumFrame(evMid, false);
  assert.equal(resMid.kind, 'tone');
  assert.ok(resMid.endFreq > resMid.startFreq * 1.4, `expected rising mid sweep, got ${resMid.startFreq} -> ${resMid.endFreq}`);
}

// 4. Short footstep burst must classify as 'blip'
{
  const ev = makeEvents([881, 1196, 1151, 1106], 31670, false);
  const res = analyzeSpectrumFrame(ev, false);
  assert.equal(res.kind, 'blip');
}

// 5. Chaotic / jittery interval burst must classify as 'noise'
{
  const ev = makeEvents([310, 1420, 240, 1890, 410, 1120, 290, 1640, 350, 980, 260, 1510], 30000, false);
  const res = analyzeSpectrumFrame(ev, false);
  assert.equal(res.kind, 'noise');
  assert.ok(res.noiseMix >= 0.45 && res.noiseClockHz > 400);
}

// 6. Asymmetric pulse-width intervals should extract non-0.5 duty cycle
{
  const ev = makeEvents([2300, 1500, 2300, 1500, 2300, 1500, 2300, 1500], 33000, false);
  const res = analyzeSpectrumFrame(ev, false);
  assert.equal(res.kind, 'tone');
  assert.ok(Math.abs(res.duty - 0.5) > 0.08, `expected asymmetric duty, got ${res.duty}`);
}

// 7. Synthesis continuity, bounded amplitude, and exponential release tail
{
  const sampleRate = 48000;
  const frameSamples = 960;
  const state = createSidSynthState();
  const toneEv = makeEvents([4910, 1227, 1227, 1227, 1227, 1227, 1227, 1227], 1000, false);
  const bufActive = new Float32Array(frameSamples);
  synthesizeC64Frame(state, analyzeSpectrumFrame(toneEv, false), sampleRate, bufActive);

  let peak = 0;
  for (const s of bufActive) {
    assert.ok(Number.isFinite(s));
    peak = Math.max(peak, Math.abs(s));
  }
  assert.ok(peak > 0.02 && peak <= 0.95, `unexpected active peak ${peak}`);

  // Silent frame immediately after should smoothly decay (release tail), not snap to zero at sample 0
  const bufRelease = new Float32Array(frameSamples);
  synthesizeC64Frame(state, analyzeSpectrumFrame(new Uint32Array(0), state.lastRawLevel), sampleRate, bufRelease);
  const headRms = Math.sqrt(bufRelease.slice(0, 120).reduce((a, b) => a + b * b, 0) / 120);
  const tailRms = Math.sqrt(bufRelease.slice(-120).reduce((a, b) => a + b * b, 0) / 120);
  assert.ok(headRms > 0.005 && tailRms < headRms, `expected decaying release tail: head=${headRms}, tail=${tailRms}`);

  // Legacy spectrum renderer sanity check
  const bufSpec = new Float32Array(frameSamples);
  renderSpectrumBeeperFrame(createSidSynthState(), toneEv, 0, sampleRate, bufSpec);
  assert.ok(bufSpec.some(v => Math.abs(v) > 0.001));
}

// 8. End-to-end integration against real Starquake WASM audioEvents
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
  for (let f = 1; f <= 60; f++) {
    if (f === 40) e.emu_set_key_row(2, 0xff & ~1); // Press Up (Q)
    if (f === 52) e.emu_set_key_row(2, 0xff);
    e.emu_begin_frame();
    e.emu_tick_range(0, 512, 50, f, 2, 0, 15, 0, 31);
    const count = Math.min(4096, e.emu_audio_count());
    const events = count ? new Uint32Array(mem.buffer, e.emu_audio_ptr() >>> 0, count).slice() : new Uint32Array(0);
    const analysis = analyzeSpectrumFrame(events, state.lastRawLevel);
    if (analysis.kind !== 'silent') activeFrames++;
    const out = new Float32Array(Math.round((sampleRate * analysis.totalCycles) / 3500000));
    synthesizeC64Frame(state, analysis, sampleRate, out);
    for (const s of out) {
      assert.ok(Number.isFinite(s));
      maxPeak = Math.max(maxPeak, Math.abs(s));
    }
  }
  assert.ok(activeFrames >= 5, `expected active Starquake audio frames, got ${activeFrames}`);
  assert.ok(maxPeak > 0.02 && maxPeak <= 0.95, `unexpected peak ${maxPeak}`);
}

console.log('C64 SID audio analysis & synthesis tests passed.');
