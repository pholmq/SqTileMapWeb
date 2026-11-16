export type AudioStyle = 'c64' | 'spectrum';

export const SPECTRUM_CLOCK_HZ = 3_500_000;
export const SPECTRUM_FRAME_CYCLES = 70_000;

export type C64SfxPreset =
  | 'laser'
  | 'platform'
  | 'footstep'
  | 'pickup'
  | 'hover_up'
  | 'glide_down'
  | 'chime'
  | 'explosion_small'
  | 'explosion_big';

interface SidVoice {
  active: boolean;
  elapsedSec: number;
  durationSec: number;
  attackSec: number;
  decaySec: number;
  startFreq: number;
  endFreq: number;
  step2AtSec: number;
  step2Freq: number;
  vibratoHz: number;
  vibratoDepthHz: number;
  pulseMix: number;
  sawMix: number;
  triMix: number;
  noiseMix: number;
  duty: number;
  quantize50Hz: boolean;
  noiseStartHz: number;
  noiseEndHz: number;
  filterStartHz: number;
  filterEndHz: number;
  filterQ: number;
  gain: number;
  phase: number;
  noisePhase: number;
  noiseSample: number;
  lfsr: number;
  svfLow: number;
  svfBand: number;
}

export interface SidSynthState {
  timeSec: number;
  lastRawLevel: boolean;
  prevRemFrames: number;
  prevStep: number;
  cooldownUntil: Record<C64SfxPreset, number>;
  voices: SidVoice[];
  spectrumLowPass: number;
  spectrumPreviousInput: number;
  spectrumHighPass: number;
}

function makeCooldowns(): Record<C64SfxPreset, number> {
  return {
    laser: 0,
    platform: 0,
    footstep: 0,
    pickup: 0,
    hover_up: 0,
    glide_down: 0,
    chime: 0,
    explosion_small: 0,
    explosion_big: 0,
  };
}

export function createSidSynthState(): SidSynthState {
  return {
    timeSec: 0,
    lastRawLevel: false,
    prevRemFrames: 0,
    prevStep: 0,
    cooldownUntil: makeCooldowns(),
    voices: [],
    spectrumLowPass: 0,
    spectrumPreviousInput: 0,
    spectrumHighPass: 0,
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
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

function stepSidLfsr(voice: SidVoice): number {
  const bit22 = (voice.lfsr >>> 22) & 1;
  const bit17 = (voice.lfsr >>> 17) & 1;
  voice.lfsr = ((voice.lfsr << 1) | (bit22 ^ bit17)) & 0x7fffff;
  if (voice.lfsr === 0) voice.lfsr = 0x7ffff8;
  return (((voice.lfsr >>> 15) & 0xff) / 127.5) - 1;
}

function spawnVoice(
  state: SidSynthState,
  config: Omit<SidVoice, 'active' | 'elapsedSec' | 'phase' | 'noisePhase' | 'noiseSample' | 'lfsr' | 'svfLow' | 'svfBand'>,
) {
  if (state.voices.length >= 8) {
    state.voices.shift();
  }
  state.voices.push({
    ...config,
    active: true,
    elapsedSec: 0,
    phase: 0,
    noisePhase: 0,
    noiseSample: 0,
    lfsr: 0x7ffff8,
    svfLow: 0,
    svfBand: 0,
  });
}

export function triggerC64Preset(state: SidSynthState, preset: C64SfxPreset) {
  const now = state.timeSec;
  if (now < state.cooldownUntil[preset]) return;

  switch (preset) {
    case 'laser':
      // Measured from C64 Starquake longplay: crisp 6581 Sawtooth 880 -> 430 Hz (50 Hz stepped) + initial noise/sub punch
      state.cooldownUntil.laser = now + 0.095;
      spawnVoice(state, {
        durationSec: 0.28,
        attackSec: 0.002,
        decaySec: 0.24,
        startFreq: 880,
        endFreq: 425,
        step2AtSec: 0,
        step2Freq: 0,
        vibratoHz: 0,
        vibratoDepthHz: 0,
        pulseMix: 0.20,
        sawMix: 0.80,
        triMix: 0,
        noiseMix: 0,
        duty: 0.5,
        quantize50Hz: true,
        noiseStartHz: 0,
        noiseEndHz: 0,
        filterStartHz: 5600,
        filterEndHz: 2600,
        filterQ: 0.8,
        gain: 0.25,
      });
      spawnVoice(state, {
        durationSec: 0.032,
        attackSec: 0.001,
        decaySec: 0.025,
        startFreq: 160,
        endFreq: 75,
        step2AtSec: 0,
        step2Freq: 0,
        vibratoHz: 0,
        vibratoDepthHz: 0,
        pulseMix: 0,
        sawMix: 0,
        triMix: 0.35,
        noiseMix: 0.65,
        duty: 0.5,
        quantize50Hz: false,
        noiseStartHz: 4200,
        noiseEndHz: 1400,
        filterStartHz: 4200,
        filterEndHz: 1500,
        filterQ: 1.4,
        gain: 0.19,
      });
      break;

    case 'platform':
      // Measured from C64 Starquake: clean 445 -> 882 Hz 50% square octave pop
      state.cooldownUntil.platform = now + 0.10;
      spawnVoice(state, {
        durationSec: 0.14,
        attackSec: 0.001,
        decaySec: 0.11,
        startFreq: 445,
        endFreq: 445,
        step2AtSec: 0.045,
        step2Freq: 882,
        vibratoHz: 0,
        vibratoDepthHz: 0,
        pulseMix: 0.85,
        sawMix: 0.15,
        triMix: 0,
        noiseMix: 0,
        duty: 0.50,
        quantize50Hz: true,
        noiseStartHz: 0,
        noiseEndHz: 0,
        filterStartHz: 5200,
        filterEndHz: 3600,
        filterQ: 0.8,
        gain: 0.24,
      });
      break;

    case 'footstep':
      // Measured from C64 Starquake (t=979.58s): bassy 120 -> 70 Hz SID thump/blup
      state.cooldownUntil.footstep = now + 0.105;
      spawnVoice(state, {
        durationSec: 0.068,
        attackSec: 0.001,
        decaySec: 0.052,
        startFreq: 155,
        endFreq: 68,
        step2AtSec: 0,
        step2Freq: 0,
        vibratoHz: 0,
        vibratoDepthHz: 0,
        pulseMix: 0.25,
        sawMix: 0.15,
        triMix: 0.60,
        noiseMix: 0,
        duty: 0.45,
        quantize50Hz: false,
        noiseStartHz: 0,
        noiseEndHz: 0,
        filterStartHz: 750,
        filterEndHz: 260,
        filterQ: 1.0,
        gain: 0.29,
      });
      break;

    case 'pickup':
      // Crisp 880 Hz -> 1180 Hz bright SID square chime
      state.cooldownUntil.pickup = now + 0.085;
      spawnVoice(state, {
        durationSec: 0.14,
        attackSec: 0.001,
        decaySec: 0.11,
        startFreq: 660,
        endFreq: 660,
        step2AtSec: 0.04,
        step2Freq: 990,
        vibratoHz: 0,
        vibratoDepthHz: 0,
        pulseMix: 0.85,
        sawMix: 0.15,
        triMix: 0,
        noiseMix: 0,
        duty: 0.50,
        quantize50Hz: true,
        noiseStartHz: 0,
        noiseEndHz: 0,
        filterStartHz: 5600,
        filterEndHz: 3800,
        filterQ: 0.8,
        gain: 0.23,
      });
      break;

    case 'hover_up':
      // Bubbly 50 Hz-stepped C64 SID arpeggio/pulse chirp (440 -> 880 Hz)
      state.cooldownUntil.hover_up = now + 0.34;
      spawnVoice(state, {
        durationSec: 0.18,
        attackSec: 0.002,
        decaySec: 0.15,
        startFreq: 460,
        endFreq: 900,
        step2AtSec: 0,
        step2Freq: 0,
        vibratoHz: 25,
        vibratoDepthHz: 55,
        pulseMix: 0.70,
        sawMix: 0.30,
        triMix: 0,
        noiseMix: 0,
        duty: 0.50,
        quantize50Hz: true,
        noiseStartHz: 0,
        noiseEndHz: 0,
        filterStartHz: 5200,
        filterEndHz: 3200,
        filterQ: 0.9,
        gain: 0.20,
      });
      break;

    case 'glide_down':
      // Crisp 50 Hz-stepped C64 Sawtooth descent (880 -> 580 Hz, 180 ms)
      state.cooldownUntil.glide_down = now + 0.36;
      spawnVoice(state, {
        durationSec: 0.18,
        attackSec: 0.002,
        decaySec: 0.15,
        startFreq: 880,
        endFreq: 560,
        step2AtSec: 0,
        step2Freq: 0,
        vibratoHz: 0,
        vibratoDepthHz: 0,
        pulseMix: 0.25,
        sawMix: 0.75,
        triMix: 0,
        noiseMix: 0,
        duty: 0.50,
        quantize50Hz: true,
        noiseStartHz: 0,
        noiseEndHz: 0,
        filterStartHz: 5400,
        filterEndHz: 2600,
        filterQ: 0.8,
        gain: 0.20,
      });
      break;

    case 'chime':
      // Crisp 880 -> 660 Hz SID square ping
      state.cooldownUntil.chime = now + 0.16;
      spawnVoice(state, {
        durationSec: 0.16,
        attackSec: 0.001,
        decaySec: 0.13,
        startFreq: 880,
        endFreq: 880,
        step2AtSec: 0.05,
        step2Freq: 660,
        vibratoHz: 0,
        vibratoDepthHz: 0,
        pulseMix: 0.85,
        sawMix: 0.15,
        triMix: 0,
        noiseMix: 0,
        duty: 0.50,
        quantize50Hz: true,
        noiseStartHz: 0,
        noiseEndHz: 0,
        filterStartHz: 5400,
        filterEndHz: 3200,
        filterQ: 0.8,
        gain: 0.22,
      });
      break;

    case 'explosion_small':
      // Measured from C64 Starquake (1014.95s): crunchy 340 Hz Sawtooth + SID LFSR noise burst
      state.cooldownUntil.explosion_small = now + 0.11;
      spawnVoice(state, {
        durationSec: 0.16,
        attackSec: 0.001,
        decaySec: 0.13,
        startFreq: 340,
        endFreq: 140,
        step2AtSec: 0,
        step2Freq: 0,
        vibratoHz: 0,
        vibratoDepthHz: 0,
        pulseMix: 0,
        sawMix: 0.35,
        triMix: 0,
        noiseMix: 0.65,
        duty: 0.5,
        quantize50Hz: true,
        noiseStartHz: 4800,
        noiseEndHz: 750,
        filterStartHz: 3600,
        filterEndHz: 620,
        filterQ: 1.6,
        gain: 0.30,
      });
      break;

    case 'explosion_big':
      // Measured from C64 Starquake (1014.95s & 4040s): 340 -> 90 Hz Sawtooth + deep sweeping LFSR noise
      state.cooldownUntil.explosion_big = now + 0.25;
      spawnVoice(state, {
        durationSec: 0.44,
        attackSec: 0.002,
        decaySec: 0.34,
        startFreq: 340,
        endFreq: 68,
        step2AtSec: 0,
        step2Freq: 0,
        vibratoHz: 0,
        vibratoDepthHz: 0,
        pulseMix: 0,
        sawMix: 0.30,
        triMix: 0,
        noiseMix: 0.70,
        duty: 0.5,
        quantize50Hz: true,
        noiseStartHz: 5200,
        noiseEndHz: 420,
        filterStartHz: 4200,
        filterEndHz: 260,
        filterQ: 2.0,
        gain: 0.36,
      });
      break;
  }
}

/**
 * Inspects Spectrum RAM (0xA41B..0xA422) and port 0xFE toggles to detect exact
 * Starquake gameplay sound triggers and return which C64 SID presets should fire.
 */
export function detectC64Triggers(
  events: Uint32Array,
  sfxRam: Uint8Array | undefined,
  state: SidSynthState,
): C64SfxPreset[] {
  const triggered: C64SfxPreset[] = [];
  let level = state.lastRawLevel;
  let cycleOffset = 0;
  let previousCycle = -1;
  const toggles: number[] = [];

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
      toggles.push(absCycle);
      level = bit;
    }
  }
  state.lastRawLevel = level;

  // 1. Multi-frame SFX table triggers from active-room RAM 0xA41B..0xA422
  const prevRem = state.prevRemFrames;
  let rem = 0;
  if (sfxRam && sfxRam.length >= 7) {
    rem = sfxRam[2]; // 0xA41D: remaining frames
    const stepRaw = sfxRam[4]; // 0xA41F: signed pitch delta
    const step = stepRaw > 127 ? stepRaw - 256 : stepRaw;

    const newRamSound =
      rem > 0 &&
      (rem > prevRem || prevRem === 0 || step !== state.prevStep);

    if (newRamSound) {
      if (step === -9 && rem <= 8) {
        triggered.push('laser');
      } else if (step === 10 && rem <= 5) {
        triggered.push('platform');
      } else if (rem >= 25) {
        triggered.push('explosion_big');
      } else if (step < 0) {
        triggered.push('hover_up');
      } else if (step > 0) {
        triggered.push('glide_down');
      } else {
        triggered.push('chime');
      }
    }
    state.prevRemFrames = rem;
    state.prevStep = step;
  } else {
    state.prevRemFrames = 0;
  }

  // 2. Immediate 0xD7C0 SFX bursts from port 0xFE toggle signatures
  const hasRealBurst =
    toggles.length >= 3 ||
    (toggles.length === 2 && toggles[1] - toggles[0] <= 18_000);

  const isOnlyA5beWindow = (rem > 0 || prevRem > 0) && toggles.length > 0 && toggles[0] >= 18_000;

  if (hasRealBurst && !isOnlyA5beWindow) {
    const intervals: number[] = [];
    for (let i = 1; i < toggles.length; i++) {
      const dt = toggles[i] - toggles[i - 1];
      if (dt >= 40 && dt <= 16_000) intervals.push(dt);
    }

    if (intervals.length > 0) {
      const span = toggles[toggles.length - 1] - toggles[0];
      let sum = 0;
      for (const dt of intervals) sum += dt;
      const mean = sum / intervals.length;
      let variance = 0;
      for (const dt of intervals) variance += (dt - mean) * (dt - mean);
      const cv = mean > 0 ? Math.sqrt(variance / intervals.length) / mean : 0;

      const head = intervals[0];
      const tail = intervals[intervals.length - 1];

      if (toggles.length <= 10 && span < 14_000 && mean >= 600) {
        triggered.push('footstep');
      } else if (toggles.length <= 28 && span < 18_000 && tail < head * 0.72) {
        triggered.push('pickup');
      } else if (cv >= 0.26 && intervals.length >= 12) {
        triggered.push(intervals.length >= 55 ? 'explosion_big' : 'explosion_small');
      } else if (intervals.length >= 6) {
        triggered.push(tail < head * 0.85 ? 'chime' : 'glide_down');
      }
    }
  }

  return triggered;
}

/**
 * Renders `sampleCount` samples of the active polyphonic 6581 SID voices into `out`.
 */
export function synthesizeC64Frame(
  state: SidSynthState,
  events: Uint32Array,
  sfxRam: Uint8Array | undefined,
  sampleRate: number,
  out: Float32Array,
): void {
  const presets = detectC64Triggers(events, sfxRam, state);
  for (const preset of presets) {
    triggerC64Preset(state, preset);
  }

  const count = out.length;
  const dtSec = 1 / sampleRate;

  if (state.voices.length === 0) {
    out.fill(0);
    state.timeSec += count * dtSec;
    return;
  }

  for (let i = 0; i < count; i++) {
    let mix = 0;
    for (let v = 0; v < state.voices.length; v++) {
      const voice = state.voices[v];
      if (!voice.active) continue;

      const t = voice.elapsedSec;
      if (t >= voice.durationSec) {
        voice.active = false;
        continue;
      }

      // Quantize parameter updates to 50 Hz (20 ms) PAL C64 IRQ steps when enabled
      const stepT = voice.quantize50Hz ? Math.floor(t * 50) / 50 : t;
      const progress = clamp(stepT / voice.durationSec, 0, 1);

      let env: number;
      if (t < voice.attackSec) {
        env = t / Math.max(0.0002, voice.attackSec);
      } else {
        const decayTime = t - voice.attackSec;
        env = Math.exp(-decayTime / Math.max(0.005, voice.decaySec * 0.45));
      }
      if (t / voice.durationSec > 0.9) {
        env *= (1 - t / voice.durationSec) / 0.1;
      }

      let freq = voice.startFreq + (voice.endFreq - voice.startFreq) * progress;
      if (voice.step2AtSec > 0 && t >= voice.step2AtSec) {
        freq = voice.step2Freq;
      }
      if (voice.vibratoHz > 0 && voice.vibratoDepthHz > 0) {
        freq += voice.vibratoDepthHz * Math.sin(2 * Math.PI * voice.vibratoHz * stepT);
      }
      freq = clamp(freq, 40, 4000);

      let oscSample = 0;
      if (voice.pulseMix > 0 || voice.sawMix > 0 || voice.triMix > 0) {
        const phaseInc = freq / sampleRate;
        voice.phase = (voice.phase + phaseInc) % 1;
        let pulse = 0;
        if (voice.pulseMix > 0) {
          pulse = voice.phase < voice.duty ? 1 : -1;
          pulse -= polyBlep(voice.phase, phaseInc);
          pulse += polyBlep((voice.phase - voice.duty + 1) % 1, phaseInc);
        }
        let saw = 0;
        if (voice.sawMix > 0) {
          saw = 2 * voice.phase - 1 - polyBlep(voice.phase, phaseInc);
        }
        let tri = 0;
        if (voice.triMix > 0) {
          tri = 1 - 4 * Math.abs(voice.phase - 0.5);
        }
        oscSample = pulse * voice.pulseMix + saw * voice.sawMix + tri * voice.triMix;
      }

      if (voice.noiseMix > 0) {
        const noiseHz = voice.noiseStartHz + (voice.noiseEndHz - voice.noiseStartHz) * progress;
        voice.noisePhase += clamp(noiseHz, 120, 10000) / sampleRate;
        while (voice.noisePhase >= 1) {
          voice.noisePhase -= 1;
          voice.noiseSample = stepSidLfsr(voice);
        }
        oscSample = oscSample * (1 - voice.noiseMix) + voice.noiseSample * voice.noiseMix;
      }

      const cutoffHz = clamp(
        voice.filterStartHz + (voice.filterEndHz - voice.filterStartHz) * progress,
        120,
        sampleRate * 0.42,
      );
      const f = 2 * Math.sin((Math.PI * cutoffHz) / sampleRate);
      const q = 1 / Math.max(0.5, voice.filterQ);
      const high = oscSample - voice.svfLow - q * voice.svfBand;
      voice.svfBand += f * high;
      voice.svfLow += f * voice.svfBand;

      mix += voice.svfLow * env * voice.gain;
      voice.elapsedSec += dtSec;
    }

    out[i] = clamp(Math.tanh(mix * 1.1), -0.95, 0.95);
  }

  state.voices = state.voices.filter(v => v.active);
  state.timeSec += count * dtSec;
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
    const rolloff = 1 / (1 + (n / 12) * (n / 12));
    imag[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty) * rolloff;
  }
  return context.createPeriodicWave(real, imag, { disableNormalization: false });
}

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

    const c64BusInput = context.createGain();
    c64BusInput.gain.value = this.style === 'c64' ? 1 : 0;

    // Brighter 6581 master rolloff (5.8 kHz) so Sawtooth/Square harmonics stay crisp
    const sidLowpass = context.createBiquadFilter();
    sidLowpass.type = 'lowpass';
    sidLowpass.frequency.value = 5800;
    sidLowpass.Q.value = 0.7;

    const dryGain = context.createGain();
    dryGain.gain.value = 0.88;

    const delayL = context.createDelay(0.5);
    delayL.delayTime.value = 0.10;
    const delayR = context.createDelay(0.5);
    delayR.delayTime.value = 0.155;
    const echoLpL = context.createBiquadFilter();
    echoLpL.type = 'lowpass';
    echoLpL.frequency.value = 2400;
    const echoLpR = context.createBiquadFilter();
    echoLpR.type = 'lowpass';
    echoLpR.frequency.value = 2100;
    const echoFbL = context.createGain();
    echoFbL.gain.value = 0.12;
    const echoFbR = context.createGain();
    echoFbR.gain.value = 0.12;
    const echoMerger = context.createChannelMerger(2);
    const echoWet = context.createGain();
    echoWet.gain.value = 0.14;

    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -10;
    compressor.knee.value = 10;
    compressor.ratio.value = 3.5;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.10;

    const masterGain = context.createGain();
    masterGain.gain.value = 0.92;

    c64BusInput.connect(sidLowpass);
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
    this.synthState.voices = [];
    this.synthState.prevRemFrames = 0;
    this.synthState.prevStep = 0;
  }

  playFrame(events: Uint32Array, lastByte: number, sfxRam?: Uint8Array) {
    const context = this.context;
    if (!context) return;

    const sampleRate = context.sampleRate;
    const sampleCount = Math.max(1, Math.round((sampleRate * SPECTRUM_FRAME_CYCLES) / SPECTRUM_CLOCK_HZ));
    const samples = new Float32Array(sampleCount);

    if (this.style === 'c64') {
      synthesizeC64Frame(this.synthState, events, sfxRam, sampleRate, samples);
    } else {
      renderSpectrumBeeperFrame(this.synthState, events, lastByte, sampleRate, samples);
    }

    if (this.workletNode) {
      this.workletNode.port.postMessage(samples, [samples.buffer]);
      return;
    }

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
