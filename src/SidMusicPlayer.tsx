import { useEffect, useRef, useState } from 'react';

type Props = { onPlayingChange: (active: boolean) => void; soundOn: boolean };

type SidWorkerMessage =
  | { type: 'loaded'; songs: number; currentSong: number }
  | { type: 'error'; message: string }
  | { type: 'audio'; samples: Float32Array };

export function SidMusicPlayer({ onPlayingChange, soundOn }: Props) {
  const workerRef = useRef<Worker | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const [status, setStatus] = useState('Choose a .sid file');
  const [fileName, setFileName] = useState('');
  const [songs, setSongs] = useState(1);
  const [song, setSong] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const worker = new Worker(new URL('./sid-audio.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<SidWorkerMessage>) => {
      const message = event.data;
      if (message.type === 'loaded') {
        setSongs(message.songs);
        setSong(message.currentSong);
        setLoaded(true);
        setLoading(false);
        setStatus(message.songs > 1 ? `Loaded · ${message.songs} subtunes` : 'SID tune loaded');
      } else if (message.type === 'audio') {
        nodeRef.current?.port.postMessage({ type: 'audio', samples: message.samples }, [message.samples.buffer]);
      } else if (message.type === 'error') {
        setLoading(false);
        setStatus(message.message);
      }
    };
    worker.onerror = (event) => {
      setLoading(false);
      setStatus(event.message || 'SID worker failed');
    };
    return () => {
      worker.postMessage({ type: 'stop' });
      worker.terminate();
      nodeRef.current?.disconnect();
      if (contextRef.current) void contextRef.current.close();
      workerRef.current = null;
      nodeRef.current = null;
      gainRef.current = null;
      contextRef.current = null;
      onPlayingChange(false);
    };
  }, [onPlayingChange]);

  useEffect(() => {
    const context = contextRef.current;
    if (context && gainRef.current) gainRef.current.gain.setTargetAtTime(soundOn ? 1 : 0, context.currentTime, 0.015);
  }, [soundOn]);

  async function loadFile(file?: File) {
    if (!file) return;
    stop();
    setLoaded(false);
    setLoading(true);
    setFileName(file.name);
    setStatus('Loading SID tune…');
    try {
      const buffer = await file.arrayBuffer();
      workerRef.current?.postMessage({ type: 'load', buffer }, [buffer]);
    } catch (error) {
      setLoading(false);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function play() {
    const worker = workerRef.current;
    if (!worker || !loaded) return;
    try {
      let context = contextRef.current;
      if (!context || context.state === 'closed') {
        context = new AudioContext({ sampleRate: 48000 });
        await context.audioWorklet.addModule(`${import.meta.env.BASE_URL}sid-processor.js`);
        const node = new AudioWorkletNode(context, 'sid-stream', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
        node.port.onmessage = (event: MessageEvent<{ type: string }>) => {
          if (event.data.type === 'need-data') worker.postMessage({ type: 'render' });
        };
        const gain = context.createGain();
        gain.gain.value = soundOn ? 1 : 0;
        node.connect(gain);
        gain.connect(context.destination);
        nodeRef.current = node;
        gainRef.current = gain;
        contextRef.current = context;
      }
      await context.resume();
      worker.postMessage({ type: 'play' });
      setPlaying(true);
      setStatus('Playing C64 SID');
      onPlayingChange(true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  function stop() {
    workerRef.current?.postMessage({ type: 'stop' });
    nodeRef.current?.disconnect();
    gainRef.current?.disconnect();
    nodeRef.current = null;
    gainRef.current = null;
    if (contextRef.current) {
      void contextRef.current.close();
      contextRef.current = null;
    }
    setPlaying(false);
    onPlayingChange(false);
    if (loaded) setStatus('SID tune loaded');
  }

  async function selectSong(nextSong: number) {
    if (!Number.isFinite(nextSong) || nextSong < 0 || nextSong >= songs) return;
    stop();
    setSong(nextSong);
    workerRef.current?.postMessage({ type: 'select-song', songIndex: nextSong });
    setStatus(`Selecting subtune ${nextSong + 1}…`);
  }

  return (
    <div className="sid-player">
      <label className="sid-file-label">
        <span>{fileName || 'Load Starquake.sid (or another SID file)'}</span>
        <input type="file" accept=".sid,.psid,.rsid,audio/prs.sid,application/octet-stream" onChange={(event) => void loadFile(event.target.files?.[0])} />
      </label>
      {songs > 1 && <label className="sid-song-select">Subtune
        <select value={song} onChange={(event) => void selectSong(Number(event.target.value))}>
          {Array.from({ length: songs }, (_, index) => <option key={index} value={index}>{index + 1}</option>)}
        </select>
      </label>}
      <div className="sid-player-actions">
        <button className="keyboard-mode-button" type="button" disabled={!loaded || loading || playing} onClick={() => void play()}>Play SID</button>
        <button className="keyboard-mode-button" type="button" disabled={!playing} onClick={stop}>Stop</button>
      </div>
      <p className="control-help sid-status" aria-live="polite">{loading ? 'Loading…' : status}</p>
    </div>
  );
}
