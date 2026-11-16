export type AudioStyle = 'c64' | 'spectrum';

export const SPECTRUM_CLOCK_HZ = 3_500_000;
export const SPECTRUM_FRAME_CYCLES = 70_000;

export interface ToggleEvent {
  cycle: number;
  level: boolean;
}

export interface PreparedC64Frame {
  toggles: ToggleEvent[];
  totalCycles: number;
  startLevel: boolean;
  endLevel: boolean;
  activeStartCycle: number;
  activeEndCycle: number;
  medianHalfPeriod: number;
  isNoise: boolean;
  noiseClockHz: number;
  isShortBurst: boolean;
  endsNearBoundary: boolean;
}

export interface SidSynthState {
  lastRawLevel: boolean;
  prevEndedActive: boolean;
  prevMedianHalfPeriod: number;
  activeEnv: number;
  releaseTauSec: number;
  tailPhase: number;
  tailFreq: number;
  hpPrevIn: number;
  hpOut: number;
  triState: number;
  noisePhase: number;
  lfsr: number;
  noiseSample: number;
  // Legacy Spectrum beeper filter state
  spectrumLowPass: number;
  spectrumPreviousInput: number;
  spectrumHighPass: number;
}

export function createSidSynthState(): SidSynthState {
  return {
    lastRawLevel: false,
    prevEndedActive: false,
    prevMedianHalfPeriod: 0,
    activeEnv: 0,
    releaseTauSec: 0.045,
    tailPhase: 0,
    tailFreq: 440,
    hpPrevIn: 0,
    hpOut: 0,
    triState: 0,
    noisePhase: 0,
    lfsr: 0x7ffff8,
    noiseSample: 0,
    spectrumLowPass: 0,
    spectrumPreviousInput: 0,
    spectrumHighPass: 0,
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Extracts exact bit-4 toggles from one frame of port 0xFE writes, suppresses
 * border-only writes, and bridges 50 Hz Z80 sprite-draw gaps inside continuous sounds.
 */
export function prepareC64FrameEvents(
  events: Uint32Array,
  state: Pick<SidSynthState, 'lastRawLevel' | 'prevEndedActive' | 'prevMedianHalfPeriod'>,
): PreparedC64Frame {
  let level = state.lastRawLevel;
  let cycleOffset = 0;
  let previousCycle = -1;
  const rawToggles: ToggleEvent[] = [];

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
      rawToggles.push({ cycle: absCycle, level: bit });
      level = bit;
    }
  }

  const totalCycles = Math.max(SPECTRUM_FRAME_CYCLES, cycleOffset + SPECTRUM_FRAME_CYCLES);

  // Ignore 0 or 1 toggle frames (border writes / static level)
  if (rawToggles.length < 2) {
    state.lastRawLevel = level;
    state.prevEndedActive = false;
    return {
      toggles: [],
      totalCycles,
      startLevel: level,
      endLevel: level,
      activeStartCycle: 0,
      activeEndCycle: 0,
      medianHalfPeriod: 0,
      isNoise: false,
      noiseClockHz: 0,
      isShortBurst: false,
      endsNearBoundary: false,
    };
  }

  // Single isolated toggle pair spanning >18,000 cycles is a border/init pulse, not audio
  if (rawToggles.length === 2 && rawToggles[1].cycle - rawToggles[0].cycle > 18_000) {
    state.lastRawLevel = level;
    state.prevEndedActive = false;
    return {
      toggles: [],
      totalCycles,
      startLevel: level,
      endLevel: level,
      activeStartCycle: 0,
      activeEndCycle: 0,
      medianHalfPeriod: 0,
      isNoise: false,
      noiseClockHz: 0,
      isShortBurst: false,
      endsNearBoundary: false,
    };
  }

  const activeInts: number[] = [];
  for (let i = 1; i < rawToggles.length; i++) {
    const dt = rawToggles[i].cycle - rawToggles[i - 1].cycle;
    if (dt >= 40 && dt <= 8000) activeInts.push(dt);
  }
  const sorted = [...activeInts].sort((a, b) => a - b);
  const medianHalfPeriod = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : 0;

  let isNoise = false;
  let noiseClockHz = 0;
  if (activeInts.length >= 6 && medianHalfPeriod > 0) {
    let sum = 0;
    for (let i = 0; i < activeInts.length; i++) sum += activeInts[i];
    const mean = sum / activeInts.length;
    let variance = 0;
    let signChanges = 0;
    let prevDiff = 0;
    for (let i = 0; i < activeInts.length; i++) {
      const d = activeInts[i] - mean;
      variance += d * d;
      if (i > 0) {
        const diff = activeInts[i] - activeInts[i - 1];
        if (i > 1 && ((diff > 0 && prevDiff < 0) || (diff < 0 && prevDiff > 0))) signChanges++;
        if (diff !== 0) prevDiff = diff;
      }
    }
    const cv = Math.sqrt(variance / activeInts.length) / mean;
    const signRatio = activeInts.length > 2 ? signChanges / (activeInts.length - 2) : 0;
    if (cv >= 0.28 && signRatio >= 0.35) {
      isNoise = true;
      noiseClockHz = clamp(SPECTRUM_CLOCK_HZ / Math.max(180, mean * 1.4), 450, 7500);
    }
  }

  let toggles = rawToggles;
  let startLevel = state.lastRawLevel;
  const endsNearBoundary =
    rawToggles.length >= 4 &&
    rawToggles[rawToggles.length - 1].cycle >= totalCycles - 8000;
  const startsAfterCpuGap =
    rawToggles.length >= 4 &&
    rawToggles[0].cycle >= 10_000 &&
    medianHalfPeriod > 0;

  // Bridge the ~10ms Z80 sprite-draw pause during continuous multi-frame sounds
  // so 50 Hz Spectrum chop becomes a smooth, continuous C64 SID sweep.
  if (
    state.prevEndedActive &&
    startsAfterCpuGap &&
    state.prevMedianHalfPeriod > 0
  ) {
    const ratio =
      Math.max(state.prevMedianHalfPeriod, medianHalfPeriod) /
      Math.min(state.prevMedianHalfPeriod, medianHalfPeriod);
    if (ratio <= 1.55) {
      const synthetic: ToggleEvent[] = [];
      let c = rawToggles[0].cycle;
      let lv = rawToggles[0].level;
      const stepStart = state.prevMedianHalfPeriod;
      const stepEnd = medianHalfPeriod;
      while (c > stepEnd * 0.25) {
        const frac = c / rawToggles[0].cycle;
        const dt = Math.max(40, stepStart + (stepEnd - stepStart) * frac);
        c -= dt;
        if (c >= 0) {
          lv = !lv;
          synthetic.push({ cycle: c, level: lv });
        }
      }
      synthetic.reverse();
      if (synthetic.length > 0) {
        startLevel = !synthetic[0].level;
        toggles = [...synthetic, ...rawToggles];
      }
    }
  }

  const activeStartCycle = toggles[0].cycle;
  const activeEndCycle = toggles[toggles.length - 1].cycle;
  const isShortBurst = rawToggles.length <= 12 && (activeEndCycle - activeStartCycle) < 14_000;

  state.lastRawLevel = level;
  state.prevEndedActive = endsNearBoundary && medianHalfPeriod > 0;
  state.prevMedianHalfPeriod = medianHalfPeriod;

  return {
    toggles,
    totalCycles,
    startLevel,
    endLevel: level,
    activeStartCycle,
    activeEndCycle,
    medianHalfPeriod,
    isNoise,
    noiseClockHz,
    isShortBurst,
    endsNearBoundary,
  };
}

function stepSidLfsr(state: SidSynthState): number {
  const bit22 = (state.lfsr >>> 22) & 1;
  const bit17 = (state.lfsr >>> 17) & 1;
  state.lfsr = ((state.lfsr << 1) | (bit22 ^ bit17)) & 0x7fffff;
  if (state.lfsr === 0) state.lfsr = 0x7ffff8;
  return (((state.lfsr >>> 15) & 0xff) / 127.5) - 1;
}

/**
 * Renders one frame of cycle-accurate C64 6581 SID-shaped audio into `out`.
 * Preserves exact timing and rhythm while eliminating 50 Hz gaps and harsh 1-bit buzz.
 */
export function synthesizeC64Frame(
  state: SidSynthState,
  frame: PreparedC64Frame,
  sampleRate: number,
  out: Float32Array,
): void {
  const sampleCount = out.length;
  const hasAudio = frame.toggles.length > 0;

  if (!hasAudio && state.activeEnv <= 0.0004 && Math.abs(state.triState) <= 0.0004 && Math.abs(state.hpOut) <= 0.0004) {
    out.fill(0);
    state.activeEnv = 0;
    state.triState = 0;
    state.hpOut = 0;
    return;
  }

  const dtSec = 1 / sampleRate;
  const sampleCycles = frame.totalCycles / sampleCount;
  const attackCoef = 1 - Math.exp(-dtSec / 0.0015);
  if (hasAudio) {
    state.releaseTauSec = frame.isShortBurst ? 0.016 : 0.048;
    if (frame.medianHalfPeriod > 0) {
      state.tailFreq = clamp(SPECTRUM_CLOCK_HZ / (2 * frame.medianHalfPeriod), 55, 2200);
    }
  }
  const releaseCoef = Math.exp(-dtSec / state.releaseTauSec);
  const hpCoef = Math.exp((-2 * Math.PI * 34) / sampleRate);
  const triDecay = Math.exp((-2 * Math.PI * 520) / sampleRate);

  const gateEndCycle = hasAudio
    ? (frame.endsNearBoundary ? frame.totalCycles : frame.activeEndCycle + Math.min(2500, Math.max(400, frame.medianHalfPeriod * 1.5)))
    : -1;

  let level = frame.startLevel;
  let toggleIdx = 0;
  const toggles = frame.toggles;
  let nextCycle = toggles.length ? toggles[0].cycle : Infinity;

  for (let sample = 0; sample < sampleCount; sample++) {
    const sampleStart = sample * sampleCycles;
    const sampleEnd = (sample + 1) * sampleCycles;
    const sampleMid = (sampleStart + sampleEnd) * 0.5;

    while (toggleIdx < toggles.length && nextCycle <= sampleStart) {
      level = toggles[toggleIdx].level;
      toggleIdx++;
      nextCycle = toggleIdx < toggles.length ? toggles[toggleIdx].cycle : Infinity;
    }

    let cursor = sampleStart;
    let area = 0;
    while (toggleIdx < toggles.length && nextCycle < sampleEnd) {
      area += (nextCycle - cursor) * (level ? 1 : -1);
      cursor = nextCycle;
      level = toggles[toggleIdx].level;
      toggleIdx++;
      nextCycle = toggleIdx < toggles.length ? toggles[toggleIdx].cycle : Infinity;
    }
    area += (sampleEnd - cursor) * (level ? 1 : -1);

    const isGateOpen = hasAudio && sampleMid >= frame.activeStartCycle && sampleMid <= gateEndCycle;
    if (isGateOpen) {
      state.activeEnv += attackCoef * (1 - state.activeEnv);
    } else {
      state.activeEnv *= releaseCoef;
    }

    let rawSq = area / sampleCycles;

    // During release tail after toggles stop, smoothly ring out with soft decaying pulse/triangle
    if (!isGateOpen && state.activeEnv > 0.001) {
      state.tailPhase = (state.tailPhase + state.tailFreq / sampleRate) % 1;
      const tailWave = state.tailPhase < 0.42 ? 1 : -1;
      rawSq = rawSq * 0.15 + tailWave * 0.85;
    }

    // DC-blocking high-pass
    state.hpOut = rawSq - state.hpPrevIn + hpCoef * state.hpOut;
    state.hpPrevIn = rawSq;

    // Warm 6581 pulse + integrated triangle blend with subtle even-harmonic asymmetry
    state.triState = state.triState * triDecay + state.hpOut * (1 - triDecay);
    const sidWave = 0.50 * state.hpOut + 0.50 * state.triState + 0.07 * state.hpOut * Math.abs(state.triState);

    let signal = sidWave;
    if (frame.isNoise && isGateOpen) {
      state.noisePhase += frame.noiseClockHz / sampleRate;
      while (state.noisePhase >= 1) {
        state.noisePhase -= 1;
        state.noiseSample = stepSidLfsr(state);
      }
      signal = sidWave * 0.78 + state.noiseSample * 0.22;
    }

    const soft = Math.tanh(signal * 1.15);
    out[sample] = clamp(soft * state.activeEnv * 0.22, -0.95, 0.95);
  }
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
const HIGHSCORE_V2 = [105.9, 105.9, 94.4, 94.4];
const HIGHSCORE_V3 = [635.1, 423.8, 565.8, 377.6];

function createSidPulseWave(context: AudioContext, duty = 0.36): PeriodicWave {
  const harmonics = 24;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    // Bandlimited pulse wave Fourier series with gentle 6581 high-harmonic roll-off
    const rolloff = 1 / (1 + (n / 10) * (n / 10));
    imag[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty) * rolloff;
  }
  return context.createPeriodicWave(real, imag, { disableNormalization: false });
}

/**
 * Glitch-free AudioWorklet-backed C64 6581 SID audio engine with BufferSource fallback.
 */
export class C64AudioEngine {
  private context: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private startingPromise: Promise<void> | null = null;
  private nextTime = 0;
  private synthState: SidSynthState = createSidSynthState();
  private c64BusInput: GainNode | null = null;
  private spectrumBypassGain: GainNode | null = null;
  private sidPulseWave: PeriodicWave | null = null;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private musicNextStepTime = 0;
  private musicStep = 0;
  private activeMusicNodes = new Set<AudioNode>();
  private style: AudioStyle = 'c64';

  setStyle(style: AudioStyle) {
    this.style = style;
    this.updateRoutingGains();
    if (style !== 'c64') {
      this.stopHighscoreMusic();
    }
  }

  private updateRoutingGains() {
    if (!this.context) return;
    const now = this.context.currentTime;
    if (this.c64BusInput) {
      this.c64BusInput.gain.setValueAtTime(this.style === 'c64' ? 1 : 0, now);
    }
    if (this.spectrumBypassGain) {
      this.spectrumBypassGain.gain.setValueAtTime(this.style === 'spectrum' ? 1 : 0, now);
    }
  }

  async start(): Promise<void> {
    if (this.context) {
      await this.context.resume();
      return;
    }
    if (this.startingPromise) {
      await this.startingPromise;
      return;
    }

    const context = new AudioContext();
    this.context = context;
    this.nextTime = context.currentTime + 0.015;
    this.synthState = createSidSynthState();
    this.sidPulseWave = createSidPulseWave(context, 0.36);

    // Warm 6581 SID bus: low-mid body + smooth 1850 Hz 2-pole LPF + subtle stereo cavern echo
    const c64BusInput = context.createGain();
    c64BusInput.gain.value = this.style === 'c64' ? 1 : 0;

    const bodyShelf = context.createBiquadFilter();
    bodyShelf.type = 'lowshelf';
    bodyShelf.frequency.value = 300;
    bodyShelf.gain.value = 3.0;

    const sidLowpass = context.createBiquadFilter();
    sidLowpass.type = 'lowpass';
    sidLowpass.frequency.value = 1850;
    sidLowpass.Q.value = 0.85;

    const dryGain = context.createGain();
    dryGain.gain.value = 0.86;

    const delayL = context.createDelay(0.5);
    delayL.delayTime.value = 0.088;
    const delayR = context.createDelay(0.5);
    delayR.delayTime.value = 0.142;
    const echoLpL = context.createBiquadFilter();
    echoLpL.type = 'lowpass';
    echoLpL.frequency.value = 1450;
    const echoLpR = context.createBiquadFilter();
    echoLpR.type = 'lowpass';
    echoLpR.frequency.value = 1350;
    const echoFbL = context.createGain();
    echoFbL.gain.value = 0.14;
    const echoFbR = context.createGain();
    echoFbR.gain.value = 0.14;
    const echoMerger = context.createChannelMerger(2);
    const echoWet = context.createGain();
    echoWet.gain.value = 0.17;

    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 10;
    compressor.ratio.value = 3.5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.10;

    const masterGain = context.createGain();
    masterGain.gain.value = 0.90;

    c64BusInput.connect(bodyShelf);
    bodyShelf.connect(sidLowpass);
    sidLowpass.connect(dryGain);
    dryGain.connect(compressor);

    sidLowpass.connect(delayL);
    sidLowpass.connect(delayR);
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

    compressor.connect(masterGain);
    masterGain.connect(context.destination);

    const spectrumBypass = context.createGain();
    spectrumBypass.gain.value = this.style === 'spectrum' ? 1 : 0;
    spectrumBypass.connect(context.destination);

    this.c64BusInput = c64BusInput;
    this.spectrumBypassGain = spectrumBypass;

    const initWorklet = async () => {
      try {
        if (!context.audioWorklet) return;
        const base = typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL ? import.meta.env.BASE_URL : '/';
        await context.audioWorklet.addModule(`${base}c64-audio-processor.js`);
        if (this.context !== context) return;
        const node = new AudioWorkletNode(context, 'c64-audio-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        node.connect(c64BusInput);
        node.connect(spectrumBypass);
        this.workletNode = node;
      } catch {
        // Fallback to AudioBufferSourceNode scheduling if AudioWorklet is unavailable
      } finally {
        if (this.context === context) {
          await context.resume();
        }
        this.startingPromise = null;
      }
    };

    this.startingPromise = initWorklet();
    await this.startingPromise;
  }

  stop() {
    this.stopHighscoreMusic();
    this.startingPromise = null;
    if (this.workletNode) {
      this.workletNode.port.postMessage('reset');
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.context) {
      void this.context.close();
    }
    this.context = null;
    this.c64BusInput = null;
    this.spectrumBypassGain = null;
    this.sidPulseWave = null;
    this.nextTime = 0;
    this.synthState = createSidSynthState();
  }

  resetFrameQueue() {
    this.stopHighscoreMusic();
    this.workletNode?.port.postMessage('reset');
    if (this.context) {
      this.nextTime = this.context.currentTime + 0.015;
    }
    this.synthState.activeEnv = 0;
    this.synthState.prevEndedActive = false;
    this.synthState.triState = 0;
    this.synthState.hpOut = 0;
  }

  playFrame(events: Uint32Array, lastByte: number) {
    const context = this.context;
    if (!context) return;

    const sampleRate = context.sampleRate;
    const prepared = this.style === 'c64' ? prepareC64FrameEvents(events, this.synthState) : null;
    const totalCycles = prepared ? prepared.totalCycles : SPECTRUM_FRAME_CYCLES;
    const sampleCount = Math.max(1, Math.round((sampleRate * totalCycles) / SPECTRUM_CLOCK_HZ));
    const samples = new Float32Array(sampleCount);

    if (this.style === 'c64' && prepared) {
      synthesizeC64Frame(this.synthState, prepared, sampleRate, samples);
    } else {
      renderSpectrumBeeperFrame(this.synthState, events, lastByte, sampleRate, samples);
    }

    if (this.workletNode) {
      this.workletNode.port.postMessage(samples, [samples.buffer]);
      return;
    }

    // Fallback when AudioWorklet isn't available yet
    const frameDuration = sampleCount / sampleRate;
    const buffer = context.createBuffer(1, sampleCount, sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    if (this.style === 'c64' && this.c64BusInput) {
      source.connect(this.c64BusInput);
    } else if (this.spectrumBypassGain) {
      source.connect(this.spectrumBypassGain);
    } else {
      source.connect(context.destination);
    }
    const startAt = Math.max(context.currentTime + 0.004, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + frameDuration;
    source.onended = () => source.disconnect();
  }

  startHighscoreMusic() {
    if (this.style !== 'c64') return;
    if (!this.context) {
      void this.start().then(() => this.startHighscoreMusic());
      return;
    }
    const context = this.context;
    const destination = this.c64BusInput;
    if (!context || !destination || this.musicTimer !== null) return;

    this.musicStep = 0;
    this.musicNextStepTime = context.currentTime + 0.04;

    const scheduleStep = () => {
      if (!this.context || !this.c64BusInput) return;
      const lookahead = this.context.currentTime + 0.25;
      while (this.musicNextStepTime < lookahead) {
        const step = this.musicStep % 64;
        const phrase = Math.floor(step / 16);
        const start = this.musicNextStepTime;

        const leadFreq = HIGHSCORE_V1[step];
        if (leadFreq > 0 && (step === 0 || HIGHSCORE_V1[step - 1] !== leadFreq)) {
          let span = 1;
          while (step + span < 64 && HIGHSCORE_V1[step + span] === leadFreq) span++;
          this.scheduleSidVoice(leadFreq, start, span * HIGHSCORE_STEP_SEC, 0.095, true, 0.014, 0.18);
        }

        if (step % 16 === 0) {
          this.scheduleSidVoice(HIGHSCORE_V2[phrase], start, 16 * HIGHSCORE_STEP_SEC, 0.08, false, 0.02, 0.24);
          this.scheduleSidVoice(HIGHSCORE_V3[phrase], start, 16 * HIGHSCORE_STEP_SEC, 0.045, true, 0.03, 0.28);
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
    usePulse: boolean,
    attackSec: number,
    releaseSec: number,
  ) {
    const context = this.context;
    const destination = this.c64BusInput;
    if (!context || !destination) return;

    const oscA = context.createOscillator();
    const oscB = context.createOscillator();
    const gain = context.createGain();

    if (usePulse && this.sidPulseWave) {
      oscA.setPeriodicWave(this.sidPulseWave);
      oscB.setPeriodicWave(this.sidPulseWave);
    } else {
      oscA.type = 'triangle';
      oscB.type = 'triangle';
    }
    oscA.frequency.setValueAtTime(freq, startTime);
    oscB.frequency.setValueAtTime(freq * 1.003, startTime);

    const mixA = context.createGain();
    mixA.gain.value = 0.62;
    const mixB = context.createGain();
    mixB.gain.value = 0.38;

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
