export type AudioStyle = 'c64' | 'spectrum';

export const SPECTRUM_CLOCK_HZ = 3_500_000;
export const SPECTRUM_FRAME_CYCLES = 70_000;

export type FrameKind = 'silent' | 'tone' | 'blip' | 'noise';

export interface AnalyzedAudioFrame {
  kind: FrameKind;
  totalCycles: number;
  endLevel: boolean;
  startFreq: number;
  endFreq: number;
  duty: number;
  noiseMix: number;
  noiseClockHz: number;
  activeSpanRatio: number;
}

export interface SidSynthState {
  phase1: number;
  phase2: number;
  phase3: number;
  pwmPhase: number;
  noisePhase: number;
  lfsr: number;
  noiseSample: number;
  currentFreq: number;
  envGain: number;
  releaseTauSec: number;
  transientEnv: number;
  lastActiveKind: FrameKind;
  lastRawLevel: boolean;
  spectrumLowPass: number;
  spectrumPreviousInput: number;
  spectrumHighPass: number;
}

export function createSidSynthState(): SidSynthState {
  return {
    phase1: 0,
    phase2: 0,
    phase3: 0,
    pwmPhase: 0,
    noisePhase: 0,
    lfsr: 0x7ffff8,
    noiseSample: 0,
    currentFreq: 220,
    envGain: 0,
    releaseTauSec: 0.085,
    transientEnv: 0,
    lastActiveKind: 'silent',
    lastRawLevel: false,
    spectrumLowPass: 0,
    spectrumPreviousInput: 0,
    spectrumHighPass: 0,
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clampFreq(freq: number): number {
  return clamp(freq, 48, 4200);
}

function average(values: number[]): number {
  if (!values.length) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return sum / values.length;
}

/**
 * Classifies one 50 Hz frame of ZX Spectrum port 0xFE events into pitch, duty,
 * and noise parameters while stripping border-only writes and 50 Hz CPU-busy gaps.
 */
export function analyzeSpectrumFrame(events: Uint32Array, initialLevel: boolean): AnalyzedAudioFrame {
  let level = initialLevel;
  let cycleOffset = 0;
  let previousCycle = -1;
  const toggleCycles: number[] = [];

  for (let i = 0; i < events.length; i++) {
    const raw = events[i];
    const cycle = raw >>> 8;
    if (previousCycle >= 0 && cycle + SPECTRUM_FRAME_CYCLES / 2 < previousCycle) {
      cycleOffset += SPECTRUM_FRAME_CYCLES;
    }
    const absCycle = cycle + cycleOffset;
    previousCycle = cycle;
    const bit = (raw & 0x10) !== 0;
    if (bit !== level) {
      toggleCycles.push(absCycle);
      level = bit;
    }
  }

  const totalCycles = Math.max(SPECTRUM_FRAME_CYCLES, cycleOffset + SPECTRUM_FRAME_CYCLES);

  if (toggleCycles.length < 2) {
    return {
      kind: 'silent',
      totalCycles,
      endLevel: level,
      startFreq: 0,
      endFreq: 0,
      duty: 0.5,
      noiseMix: 0,
      noiseClockHz: 0,
      activeSpanRatio: 0,
    };
  }

  const rawIntervals: number[] = [];
  for (let i = 1; i < toggleCycles.length; i++) {
    rawIntervals.push(Math.max(1, toggleCycles[i] - toggleCycles[i - 1]));
  }

  // Single stray toggle spanning most of a frame is a border/init write, not audio.
  if (rawIntervals.length === 1 && rawIntervals[0] > 18_000) {
    return {
      kind: 'silent',
      totalCycles,
      endLevel: level,
      startFreq: 0,
      endFreq: 0,
      duty: 0.5,
      noiseMix: 0,
      noiseClockHz: 0,
      activeSpanRatio: 0,
    };
  }

  // Starquake's 0xA5BE routine pauses during frame sprite logic (~4k-12k cycles) then
  // emits steady pulses. Using the 40th percentile ignores those CPU-busy frame gaps.
  const sorted = [...rawIntervals].sort((a, b) => a - b);
  const coreMedian = sorted[Math.floor(sorted.length * 0.4)];
  const gapThreshold = Math.max(coreMedian * 2.8, 320);

  let activeIntervals = rawIntervals.filter(dt => dt <= gapThreshold && dt >= 24);
  if (!activeIntervals.length) {
    activeIntervals = rawIntervals.filter(dt => dt <= 20_000);
  }
  if (!activeIntervals.length) {
    return {
      kind: 'silent',
      totalCycles,
      endLevel: level,
      startFreq: 0,
      endFreq: 0,
      duty: 0.5,
      noiseMix: 0,
      noiseClockHz: 0,
      activeSpanRatio: 0,
    };
  }

  const meanDt = average(activeIntervals);
  let variance = 0;
  for (let i = 0; i < activeIntervals.length; i++) {
    const d = activeIntervals[i] - meanDt;
    variance += d * d;
  }
  const stdDt = Math.sqrt(variance / activeIntervals.length);
  const cv = meanDt > 0 ? stdDt / meanDt : 0;

  let diffSum = 0;
  let signChanges = 0;
  let prevDiff = 0;
  for (let i = 1; i < activeIntervals.length; i++) {
    const diff = activeIntervals[i] - activeIntervals[i - 1];
    diffSum += Math.abs(diff);
    if (i > 1 && ((diff > 0 && prevDiff < 0) || (diff < 0 && prevDiff > 0))) {
      signChanges++;
    }
    if (diff !== 0) prevDiff = diff;
  }
  const jitterCv = activeIntervals.length > 1 && meanDt > 0 ? (diffSum / (activeIntervals.length - 1)) / meanDt : 0;
  const signChangeRatio = activeIntervals.length > 2 ? signChanges / (activeIntervals.length - 2) : 0;

  let startFreq: number;
  let endFreq: number;
  if (activeIntervals.length >= 4) {
    const headCount = Math.max(1, Math.floor(activeIntervals.length / 3));
    const headMean = average(activeIntervals.slice(0, headCount));
    const tailMean = average(activeIntervals.slice(-headCount));
    startFreq = clampFreq(SPECTRUM_CLOCK_HZ / (2 * headMean));
    endFreq = clampFreq(SPECTRUM_CLOCK_HZ / (2 * tailMean));
  } else {
    const freq = clampFreq(SPECTRUM_CLOCK_HZ / (2 * meanDt));
    startFreq = freq;
    endFreq = freq;
  }

  let duty = 0.5;
  if (activeIntervals.length >= 4) {
    let evenSum = 0;
    let evenCount = 0;
    let oddSum = 0;
    let oddCount = 0;
    for (let i = 0; i < activeIntervals.length; i++) {
      if ((i & 1) === 0) {
        evenSum += activeIntervals[i];
        evenCount++;
      } else {
        oddSum += activeIntervals[i];
        oddCount++;
      }
    }
    const evenMean = evenSum / evenCount;
    const oddMean = oddSum / oddCount;
    const asym = Math.abs(evenMean - oddMean) / (evenMean + oddMean);
    if (asym > 0.04) {
      duty = clamp(evenMean / (evenMean + oddMean), 0.22, 0.78);
    }
  }

  const activeSpan = toggleCycles[toggleCycles.length - 1] - toggleCycles[0];
  const activeSpanRatio = clamp(activeSpan / totalCycles, 0.2, 1.0);

  const sweepRatio = Math.max(startFreq, endFreq) / Math.max(1, Math.min(startFreq, endFreq));
  const isBlip = toggleCycles.length <= 7 && activeSpan < 14_000 && cv < 0.25 && sweepRatio < 1.25;
  const isNoise =
    !isBlip &&
    ((cv >= 0.25 && jitterCv >= 0.20 && signChangeRatio >= 0.32) ||
      (cv >= 0.55 && activeIntervals.length >= 8));

  if (isBlip) {
    return {
      kind: 'blip',
      totalCycles,
      endLevel: level,
      startFreq,
      endFreq,
      duty,
      noiseMix: 0.14,
      noiseClockHz: clamp(startFreq * 2.2, 600, 5200),
      activeSpanRatio,
    };
  }

  if (isNoise) {
    const noiseMix = clamp((cv - 0.16) * 1.35, 0.45, 0.90);
    const noiseClockHz = clamp(SPECTRUM_CLOCK_HZ / Math.max(160, meanDt * 1.35), 420, 8600);
    return {
      kind: 'noise',
      totalCycles,
      endLevel: level,
      startFreq,
      endFreq,
      duty,
      noiseMix,
      noiseClockHz,
      activeSpanRatio,
    };
  }

  return {
    kind: 'tone',
    totalCycles,
    endLevel: level,
    startFreq,
    endFreq,
    duty,
    noiseMix: 0,
    noiseClockHz: 0,
    activeSpanRatio,
  };
}

function polyBlep(phase: number, dt: number): number {
  if (dt <= 0) return 0;
  if (phase < dt) {
    const t = phase / dt;
    return t + t - t * t - 1;
  }
  if (phase > 1 - dt) {
    const t = (phase - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

function stepSidLfsr(state: SidSynthState): number {
  const bit22 = (state.lfsr >>> 22) & 1;
  const bit17 = (state.lfsr >>> 17) & 1;
  state.lfsr = ((state.lfsr << 1) | (bit22 ^ bit17)) & 0x7fffff;
  if (state.lfsr === 0) state.lfsr = 0x7ffff8;
  // Convert top 8 SID noise bits to signed [-1, 1]
  const byte = ((state.lfsr >>> 15) & 0xff);
  return (byte / 127.5) - 1;
}

/**
 * Renders one frame of C64 SID-inspired audio into `out` from an analyzed frame.
 * Maintains phase, PWM LFO, 23-bit LFSR noise, and ADSR release across frames.
 */
export function synthesizeC64Frame(
  state: SidSynthState,
  analysis: AnalyzedAudioFrame,
  sampleRate: number,
  out: Float32Array,
): void {
  const count = out.length;
  const dtSec = 1 / sampleRate;
  const isActive = analysis.kind !== 'silent';

  if (!isActive && state.envGain <= 0.0004 && state.transientEnv <= 0.0004) {
    out.fill(0);
    state.envGain = 0;
    state.transientEnv = 0;
    state.lastRawLevel = analysis.endLevel;
    return;
  }

  const attackCoef = 1 - Math.exp(-dtSec / 0.003);
  if (isActive) {
    state.releaseTauSec = analysis.kind === 'blip' ? 0.036 : analysis.kind === 'noise' ? 0.11 : 0.088;
    if (state.lastActiveKind === 'silent' || analysis.kind === 'blip') {
      state.transientEnv = analysis.kind === 'blip' ? 0.55 : 0.35;
      if (state.lastActiveKind === 'silent') {
        state.currentFreq = analysis.startFreq;
      }
    }
  }
  const releaseCoef = Math.exp(-dtSec / state.releaseTauSec);
  const transientDecay = Math.exp(-dtSec / 0.012);
  const portamentoCoef = 1 - Math.exp(-dtSec / 0.006);
  const pwmInc = 1.85 / sampleRate;

  const targetGain =
    analysis.kind === 'silent' ? 0 :
    analysis.kind === 'blip' ? 0.72 :
    analysis.kind === 'noise' ? 0.88 :
    0.84;

  const activeEndSample = analysis.kind === 'blip'
    ? Math.max(1, Math.round(count * Math.min(0.65, analysis.activeSpanRatio)))
    : count;

  const noiseRate = analysis.kind === 'noise'
    ? analysis.noiseClockHz
    : analysis.kind === 'blip'
      ? analysis.noiseClockHz
      : 2800;

  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    const frameActive = isActive && i < activeEndSample;

    if (frameActive) {
      const targetFreq = analysis.startFreq + (analysis.endFreq - analysis.startFreq) * t;
      state.currentFreq += portamentoCoef * (targetFreq - state.currentFreq);
      state.envGain += attackCoef * (targetGain - state.envGain);
    } else {
      state.envGain *= releaseCoef;
    }

    state.transientEnv *= transientDecay;

    const freq = clampFreq(state.currentFreq);
    const dt1 = freq / sampleRate;
    const dt2 = (freq * 0.5) / sampleRate;
    const dt3 = (freq * 1.004) / sampleRate;

    state.phase1 = (state.phase1 + dt1) % 1;
    state.phase2 = (state.phase2 + dt2) % 1;
    state.phase3 = (state.phase3 + dt3) % 1;
    state.pwmPhase = (state.pwmPhase + pwmInc) % 1;

    // Slow PWM sweep inspired by Starquake.sid (+3/-3 pw per frame), blended with frame duty
    const lfoPw = 0.5 + 0.23 * Math.sin(2 * Math.PI * state.pwmPhase);
    const pw = clamp(0.65 * lfoPw + 0.35 * analysis.duty, 0.18, 0.82);

    // Voice 1: PolyBLEP PWM Pulse
    let pulse1 = state.phase1 < pw ? 1 : -1;
    pulse1 -= polyBlep(state.phase1, dt1);
    pulse1 += polyBlep((state.phase1 - pw + 1) % 1, dt1);

    // Voice 2: Sub-octave Triangle + slightly detuned Chorus Pulse
    const triSub = 1 - 4 * Math.abs(state.phase2 - 0.5);
    const pw3 = clamp(1 - pw, 0.18, 0.82);
    let pulse3 = state.phase3 < pw3 ? 1 : -1;
    pulse3 -= polyBlep(state.phase3, dt3);
    pulse3 += polyBlep((state.phase3 - pw3 + 1) % 1, dt3);

    const toneSignal =
      analysis.kind === 'blip'
        ? 0.58 * triSub + 0.42 * pulse1
        : 0.56 * pulse1 + 0.28 * triSub + 0.18 * pulse3;

    // Voice 3: 23-bit SID LFSR Noise
    state.noisePhase += noiseRate / sampleRate;
    while (state.noisePhase >= 1) {
      state.noisePhase -= 1;
      state.noiseSample = stepSidLfsr(state);
    }

    const noiseWeight = analysis.kind === 'noise'
      ? analysis.noiseMix
      : clamp(state.transientEnv * 0.45, 0, 0.4);
    const mixed = toneSignal * (1 - noiseWeight * 0.65) + state.noiseSample * noiseWeight;

    out[i] = clamp(mixed * state.envGain * 0.22, -0.95, 0.95);
  }

  state.lastActiveKind = analysis.kind;
  state.lastRawLevel = analysis.endLevel;
}

/**
 * Legacy 1-bit ZX Spectrum beeper frame renderer (used when audioStyle === 'spectrum').
 */
export function renderSpectrumBeeperFrame(
  state: SidSynthState,
  events: Uint32Array,
  lastByte: number,
  sampleRate: number,
  out: Float32Array,
): void {
  const eventCycles = new Float64Array(events.length);
  let cycleOffset = 0;
  let previousCycle = -1;
  for (let i = 0; i < events.length; i++) {
    const cycle = events[i] >>> 8;
    if (previousCycle >= 0 && cycle + SPECTRUM_FRAME_CYCLES / 2 < previousCycle) {
      cycleOffset += SPECTRUM_FRAME_CYCLES;
    }
    eventCycles[i] = cycle + cycleOffset;
    previousCycle = cycle;
  }
  const totalCycles = Math.max(SPECTRUM_FRAME_CYCLES, cycleOffset + SPECTRUM_FRAME_CYCLES);
  const sampleCount = out.length;
  let level = state.lastRawLevel;
  let eventIndex = 0;
  let nextCycle = eventCycles.length ? eventCycles[0] : Infinity;
  const sampleCycles = totalCycles / sampleCount;
  const lowPassCoefficient = 1 - Math.exp((-2 * Math.PI * 4800) / sampleRate);
  const highPassCoefficient = Math.exp((-2 * Math.PI * 35) / sampleRate);
  let lowPass = state.spectrumLowPass;
  let previousInput = state.spectrumPreviousInput;
  let highPass = state.spectrumHighPass;

  for (let sample = 0; sample < sampleCount; sample++) {
    const sampleStart = sample * sampleCycles;
    const sampleEnd = (sample + 1) * sampleCycles;
    while (eventIndex < events.length && nextCycle <= sampleStart) {
      level = (events[eventIndex] & 0x10) !== 0;
      eventIndex++;
      nextCycle = eventIndex < events.length ? eventCycles[eventIndex] : Infinity;
    }
    let cursor = sampleStart;
    let area = 0;
    while (eventIndex < events.length && nextCycle < sampleEnd) {
      area += (nextCycle - cursor) * (level ? 1 : -1);
      cursor = nextCycle;
      level = (events[eventIndex] & 0x10) !== 0;
      eventIndex++;
      nextCycle = eventIndex < events.length ? eventCycles[eventIndex] : Infinity;
    }
    area += (sampleEnd - cursor) * (level ? 1 : -1);
    const input = (area / sampleCycles) * 0.14;
    lowPass += lowPassCoefficient * (input - lowPass);
    highPass = lowPass - previousInput + highPassCoefficient * highPass;
    previousInput = lowPass;
    out[sample] = highPass;
  }

  state.lastRawLevel = (lastByte & 0x10) !== 0;
  state.spectrumLowPass = lowPass;
  state.spectrumPreviousInput = previousInput;
  state.spectrumHighPass = highPass;
}

// 64-step (19.2 s loop @ 0.30 s/step) C64 Starquake theme extracted from Starquake.sid Song 2
const HIGHSCORE_STEP_SEC = 0.30;
const HIGHSCORE_V1 = [
  211.9, 211.9, 211.9, 0, 211.9, 211.9, 317.5, 317.5, 211.9, 211.9, 282.9, 282.9, 211.9, 211.9, 252.0, 252.0,
  211.9, 211.9, 211.9, 0, 211.9, 211.9, 317.5, 317.5, 211.9, 211.9, 282.9, 282.9, 211.9, 211.9, 252.0, 252.0,
  188.8, 188.8, 188.8, 0, 188.8, 188.8, 282.9, 282.9, 188.8, 188.8, 252.0, 252.0, 188.8, 188.8, 238.0, 238.0,
  188.8, 188.8, 188.8, 0, 188.8, 188.8, 282.9, 282.9, 188.8, 188.8, 252.0, 252.0, 188.8, 188.8, 238.0, 238.0,
];
const HIGHSCORE_V2 = [105.9, 105.9, 94.4, 94.4]; // 16 steps per phrase
const HIGHSCORE_V3 = [635.1, 423.8, 565.8, 377.6]; // 16 steps per phrase

function createSidSaturationCurve(): Float32Array<ArrayBuffer> {
  const samples = 512;
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    // Mild asymmetric 6581 analog stage saturation
    curve[i] = Math.tanh(x * 1.45 + 0.08 * x * x) / Math.tanh(1.53);
  }
  return curve;
}

function createCavernImpulse(context: AudioContext, durationSec = 0.72): AudioBuffer {
  const length = Math.max(1, Math.floor(context.sampleRate * durationSec));
  const buffer = context.createBuffer(2, length, context.sampleRate);
  let seed = 0x51a4e2c1;
  const nextRand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const decay = Math.pow(1 - t, 2.4) * Math.exp(-t * 3.8);
      lp = lp * 0.62 + nextRand() * 0.38;
      data[i] = lp * decay;
    }
    // Early cavern reflections
    for (const tapMs of ch === 0 ? [19, 41, 67] : [26, 49, 79]) {
      const idx = Math.floor((tapMs / 1000) * context.sampleRate);
      if (idx < length) data[idx] += 0.35;
    }
  }
  return buffer;
}

/**
 * Web Audio C64 6581 SID-style synthesizer + cavern echo/reverb engine.
 */
export class C64AudioEngine {
  private context: AudioContext | null = null;
  private nextTime = 0;
  private synthState: SidSynthState = createSidSynthState();
  private sidBusInput: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private musicNextStepTime = 0;
  private musicStep = 0;
  private activeMusicNodes = new Set<AudioNode>();
  private style: AudioStyle = 'c64';

  setStyle(style: AudioStyle) {
    this.style = style;
    if (style !== 'c64') {
      this.stopHighscoreMusic();
    }
  }

  start() {
    if (this.context) {
      void this.context.resume();
      return;
    }
    const context = new AudioContext();
    this.context = context;
    this.nextTime = context.currentTime + 0.01;
    this.synthState = createSidSynthState();

    // Persistent 6581 SID filter + saturation + stereo cavern delay & reverb bus
    const sidInput = context.createGain();
    sidInput.gain.value = 1.0;

    const sidLowpass = context.createBiquadFilter();
    sidLowpass.type = 'lowpass';
    sidLowpass.frequency.value = 2550;
    sidLowpass.Q.value = 2.2;

    const sidShaper = context.createWaveShaper();
    sidShaper.curve = createSidSaturationCurve();
    sidShaper.oversample = '2x';

    const sidHighpass = context.createBiquadFilter();
    sidHighpass.type = 'highpass';
    sidHighpass.frequency.value = 36;

    const dryGain = context.createGain();
    dryGain.gain.value = 0.78;

    // Stereo ping-pong cavern echo
    const delayL = context.createDelay(0.5);
    delayL.delayTime.value = 0.078;
    const delayR = context.createDelay(0.5);
    delayR.delayTime.value = 0.122;
    const echoLpL = context.createBiquadFilter();
    echoLpL.type = 'lowpass';
    echoLpL.frequency.value = 1950;
    const echoLpR = context.createBiquadFilter();
    echoLpR.type = 'lowpass';
    echoLpR.frequency.value = 1800;
    const echoFbL = context.createGain();
    echoFbL.gain.value = 0.24;
    const echoFbR = context.createGain();
    echoFbR.gain.value = 0.24;
    const echoWet = context.createGain();
    echoWet.gain.value = 0.26;
    const echoMerger = context.createChannelMerger(2);

    // Damped cavern reverb
    const convolver = context.createConvolver();
    convolver.buffer = createCavernImpulse(context, 0.72);
    const reverbWet = context.createGain();
    reverbWet.gain.value = 0.24;

    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 12;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.12;

    const masterGain = context.createGain();
    masterGain.gain.value = 0.85;

    sidInput.connect(sidLowpass);
    sidLowpass.connect(sidShaper);
    sidShaper.connect(sidHighpass);

    sidHighpass.connect(dryGain);
    dryGain.connect(compressor);

    sidHighpass.connect(delayL);
    sidHighpass.connect(delayR);
    delayL.connect(echoLpL);
    delayR.connect(echoLpR);
    echoLpL.connect(echoFbL);
    echoLpR.connect(echoFbR);
    echoFbL.connect(delayR);
    echoFbR.connect(delayL);
    echoLpL.connect(echoMerger, 0, 0);
    echoLpR.connect(echoMerger, 0, 1);
    echoMerger.connect(echoWet);
    echoWet.connect(compressor);

    sidHighpass.connect(convolver);
    convolver.connect(reverbWet);
    reverbWet.connect(compressor);

    compressor.connect(masterGain);
    masterGain.connect(context.destination);

    this.sidBusInput = sidInput;
    this.masterGain = masterGain;
    void context.resume();
  }

  stop() {
    this.stopHighscoreMusic();
    if (this.context) {
      void this.context.close();
    }
    this.context = null;
    this.sidBusInput = null;
    this.masterGain = null;
    this.nextTime = 0;
    this.synthState = createSidSynthState();
  }

  resetFrameQueue() {
    this.stopHighscoreMusic();
    if (this.context) {
      this.nextTime = this.context.currentTime + 0.01;
    }
    this.synthState.envGain = 0;
    this.synthState.transientEnv = 0;
    this.synthState.lastActiveKind = 'silent';
  }

  playFrame(events: Uint32Array, lastByte: number) {
    const context = this.context;
    if (!context) return;

    const sampleRate = context.sampleRate;
    const analysis = this.style === 'c64' ? analyzeSpectrumFrame(events, this.synthState.lastRawLevel) : null;
    const totalCycles = analysis ? analysis.totalCycles : SPECTRUM_FRAME_CYCLES;
    const sampleCount = Math.max(1, Math.round((sampleRate * totalCycles) / SPECTRUM_CLOCK_HZ));
    const frameDuration = sampleCount / sampleRate;

    if (
      this.style === 'c64' &&
      analysis &&
      analysis.kind === 'silent' &&
      this.synthState.envGain <= 0.0004 &&
      this.synthState.transientEnv <= 0.0004
    ) {
      this.synthState.lastRawLevel = analysis.endLevel;
      this.synthState.lastActiveKind = 'silent';
      this.nextTime = context.currentTime + 0.004;
      return;
    }

    const buffer = context.createBuffer(1, sampleCount, sampleRate);
    const samples = buffer.getChannelData(0);

    if (this.style === 'c64' && analysis) {
      synthesizeC64Frame(this.synthState, analysis, sampleRate, samples);
    } else {
      renderSpectrumBeeperFrame(this.synthState, events, lastByte, sampleRate, samples);
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    if (this.style === 'c64' && this.sidBusInput) {
      source.connect(this.sidBusInput);
    } else {
      source.connect(context.destination);
    }

    const startAt = Math.max(context.currentTime + 0.004, Math.min(this.nextTime, context.currentTime + 0.08));
    source.start(startAt);
    this.nextTime = startAt + frameDuration;
    source.onended = () => source.disconnect();
  }

  startHighscoreMusic() {
    if (this.style !== 'c64') return;
    if (!this.context) this.start();
    const context = this.context;
    const destination = this.sidBusInput;
    if (!context || !destination || this.musicTimer !== null) return;

    this.musicStep = 0;
    this.musicNextStepTime = context.currentTime + 0.04;

    const scheduleStep = () => {
      if (!this.context || !this.sidBusInput) return;
      const lookahead = this.context.currentTime + 0.25;
      while (this.musicNextStepTime < lookahead) {
        const step = this.musicStep % 64;
        const phrase = Math.floor(step / 16);
        const start = this.musicNextStepTime;

        const leadFreq = HIGHSCORE_V1[step];
        if (leadFreq > 0 && (step === 0 || HIGHSCORE_V1[step - 1] !== leadFreq)) {
          let span = 1;
          while (step + span < 64 && HIGHSCORE_V1[step + span] === leadFreq) span++;
          this.scheduleSidVoice(leadFreq, start, span * HIGHSCORE_STEP_SEC, 0.09, 'sawtooth', 0.012, 0.18);
        }

        if (step % 16 === 0) {
          this.scheduleSidVoice(HIGHSCORE_V2[phrase], start, 16 * HIGHSCORE_STEP_SEC, 0.075, 'triangle', 0.02, 0.25);
          this.scheduleSidVoice(HIGHSCORE_V3[phrase], start, 16 * HIGHSCORE_STEP_SEC, 0.045, 'square', 0.03, 0.30);
        }

        this.musicStep = (this.musicStep + 1) % 64;
        this.musicNextStepTime += HIGHSCORE_STEP_SEC;
      }
    };

    scheduleStep();
    this.musicTimer = setInterval(scheduleStep, 80);
  }

  stopHighscoreMusic() {
    if (this.musicTimer !== null) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
    for (const node of this.activeMusicNodes) {
      try {
        if ('stop' in node && typeof (node as OscillatorNode).stop === 'function') {
          (node as OscillatorNode).stop();
        }
        node.disconnect();
      } catch {
        /* Ignore already-stopped Web Audio nodes. */
      }
    }
    this.activeMusicNodes.clear();
  }

  private scheduleSidVoice(
    freq: number,
    startTime: number,
    durationSec: number,
    peakGain: number,
    type: OscillatorType,
    attackSec: number,
    releaseSec: number,
  ) {
    const context = this.context;
    const destination = this.sidBusInput;
    if (!context || !destination) return;

    const oscA = context.createOscillator();
    const oscB = context.createOscillator();
    const gain = context.createGain();

    oscA.type = type;
    oscA.frequency.setValueAtTime(freq, startTime);
    oscB.type = 'square';
    oscB.frequency.setValueAtTime(freq * 1.0035, startTime);

    const mixA = context.createGain();
    mixA.gain.value = 0.65;
    const mixB = context.createGain();
    mixB.gain.value = 0.35;

    const sustainEnd = Math.max(startTime + attackSec + 0.01, startTime + durationSec - 0.02);
    const stopTime = sustainEnd + releaseSec;

    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + attackSec);
    gain.gain.exponentialRampToValueAtTime(peakGain * 0.52, sustainEnd);
    gain.gain.exponentialRampToValueAtTime(0.0001, stopTime);

    oscA.connect(mixA);
    oscB.connect(mixB);
    mixA.connect(gain);
    mixB.connect(gain);
    gain.connect(destination);

    this.activeMusicNodes.add(oscA);
    this.activeMusicNodes.add(oscB);
    this.activeMusicNodes.add(gain);

    oscA.start(startTime);
    oscB.start(startTime);
    oscA.stop(stopTime + 0.02);
    oscB.stop(stopTime + 0.02);

    oscA.onended = () => {
      oscA.disconnect();
      oscB.disconnect();
      mixA.disconnect();
      mixB.disconnect();
      gain.disconnect();
      this.activeMusicNodes.delete(oscA);
      this.activeMusicNodes.delete(oscB);
      this.activeMusicNodes.delete(gain);
    };
  }
}
