import { SidAudioEngine } from 'libsidplayfp-wasm';

type Command =
  | { type: 'load'; buffer: ArrayBuffer }
  | { type: 'play' }
  | { type: 'stop' }
  | { type: 'render' }
  | { type: 'select-song'; songIndex: number };

let engine: SidAudioEngine | null = null;
let running = false;
let rendering = false;

async function renderNext() {
  if (!running || rendering || !engine) return;
  rendering = true;
  try {
    const pcm = await engine.renderFrames(2048, undefined, undefined, { loop: true });
    if (running && pcm.length) {
      const samples = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
      self.postMessage({ type: 'audio', samples }, [samples.buffer]);
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    running = false;
  } finally {
    rendering = false;
  }
}

self.onmessage = async (event: MessageEvent<Command>) => {
  const message = event.data;
  try {
    if (message.type === 'load') {
      running = false;
      engine?.dispose();
      engine = new SidAudioEngine({ sampleRate: 48000, stereo: true, engine: 'residfp' });
      await engine.loadSidBuffer(new Uint8Array(message.buffer));
      const info = engine.getTuneInfo();
      self.postMessage({ type: 'loaded', songs: info?.songs ?? 1, currentSong: info?.currentSong ?? 0 });
    } else if (message.type === 'play') {
      running = true;
    } else if (message.type === 'stop') {
      running = false;
    } else if (message.type === 'select-song' && engine) {
      running = false;
      await engine.selectSong(message.songIndex);
      self.postMessage({ type: 'loaded', songs: engine.getTuneInfo()?.songs ?? 1, currentSong: message.songIndex });
    } else if (message.type === 'render') {
      await renderNext();
    }
  } catch (error) {
    running = false;
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
