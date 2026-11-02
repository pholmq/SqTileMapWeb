import { ChangeEvent, PointerEvent, WheelEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Pause, Play, Plus, Scan, Volume2, VolumeX, Crosshair, Upload, RotateCcw } from 'lucide-react';
import { MAP_HEIGHT, MAP_WIDTH, paintSpectrumRoom, spectrumScreenHasFlash } from './spectrum';

type WorkerMessage =
  | { type: 'module-ready'; workerIndex: number; workerCount: number; shared: boolean; rangeStart: number; rangeEnd: number }
  | { type: 'ready'; roomCount: number; currentRoom: number }
  | { type: 'error'; message: string }
  | { type: 'begin-done'; frameId: number }
  | { type: 'tick-done'; frameId: number; workerIndex: number }
  | { type: 'collected'; frameId: number; workerIndex: number; dirty: { room: number; screen: ArrayBuffer }[]; audioEvents: Uint32Array; audioLast: number; currentRoom: number; audioOverflow: boolean };
type Camera = { scale: number; x: number; y: number };
type FrameState = { id: number; phase: 'begin' | 'tick' | 'collect'; started: number; tickDone: Set<number>; collectDone: Set<number>; dirty: { room: number; screen: ArrayBuffer }[]; audioEvents: Uint32Array; audioLast: number; currentRoom: number };
const INITIAL_KEYS = [255, 255, 255, 255, 255, 255, 255, 255];
type GameAction = 'up' | 'down' | 'left' | 'right' | 'fire';
type ControlBinding = { action: GameAction; label: string; code: string; row: number; bit: number };
const DEFAULT_CONTROLS: ControlBinding[] = [
  { action: 'up', label: 'Up', code: 'KeyQ', row: 2, bit: 0 },
  { action: 'down', label: 'Down / platform', code: 'KeyA', row: 1, bit: 0 },
  { action: 'left', label: 'Left', code: 'KeyO', row: 5, bit: 1 },
  { action: 'right', label: 'Right', code: 'KeyP', row: 5, bit: 0 },
  { action: 'fire', label: 'Fire', code: 'Space', row: 7, bit: 0 },
];
const CONTROL_STORAGE_KEY = 'starquake-controls-v1';
function readControls(): ControlBinding[] {
  try {
    const saved = JSON.parse(localStorage.getItem(CONTROL_STORAGE_KEY) || 'null');
    if (Array.isArray(saved)) return DEFAULT_CONTROLS.map(base => {
      const match = saved.find((item: any) => item?.action === base.action && typeof item.code === 'string');
      return match ? { ...base, code: match.code } : base;
    });
  } catch { /* Use defaults when saved settings are unavailable. */ }
  return DEFAULT_CONTROLS.map(control => ({ ...control }));
}
function formatControlKey(code: string) {
  if (!code) return '—';
  if (code === 'Space') return 'SPACE';
  if (code.startsWith('Key')) return code.slice(3).toUpperCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'NUM ' + code.slice(6);
  const names: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'ENTER', Escape: 'ESC', ShiftLeft: 'LEFT SHIFT', ShiftRight: 'RIGHT SHIFT' };
  return names[code] || code.toUpperCase();
}

export default function App() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const mapCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const workersRef = useRef<Worker[]>([]);
  const workerCountRef = useRef(1);
  const poolReadyRef = useRef(false);
  const moduleReadyRef = useRef(new Set<number>());
  const cameraRef = useRef<Camera>({ scale: 0.15, x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; cameraX: number; cameraY: number } | null>(null);
  const keyRowsRef = useRef<number[]>([...INITIAL_KEYS]);
  const pressedCodesRef = useRef(new Set<string>());
  const captureActionRef = useRef<GameAction | null>(null);
  const flashRoomsRef = useRef<boolean[]>(Array(512).fill(false));
  const audioRef = useRef<{ context: AudioContext | null; oscillator: OscillatorNode | null; gain: GainNode | null }>({ context: null, oscillator: null, gain: null });
  const snapshotRef = useRef<ArrayBuffer | null>(null);
  const frameStateRef = useRef<FrameState | null>(null);
  const frameIdRef = useRef(0);
  const currentRoomRef = useRef(8);
  const screenCacheRef = useRef<(Uint8Array | null)[]>(Array(512).fill(null));
  const lastFlashPhaseRef = useRef(false);
  const frameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playingRef = useRef(false);
  const fpsCounterRef = useRef({ started: 0, frames: 0 });
  const telemetryUpdateRef = useRef(0);
  const soundOnRef = useRef(true);
  const backgroundDivisorRef = useRef(5);
  const [camera, setCamera] = useState<Camera>(cameraRef.current);
  const [status, setStatus] = useState('Preparing browser emulator…');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [poolReady, setPoolReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentRoom, setCurrentRoom] = useState(8);
  const [fps, setFps] = useState(0);
  const [frameMs, setFrameMs] = useState(0);
  const [roomCount, setRoomCount] = useState(512);
  const [workerCount, setWorkerCount] = useState(1);
  const [cheats, setCheats] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [backgroundDivisor, setBackgroundDivisor] = useState(5);
  const [romName, setRomName] = useState('');
  const [snapshotName, setSnapshotName] = useState('No snapshot loaded');
  const [controls, setControls] = useState<ControlBinding[]>(readControls);
  const [capturingAction, setCapturingAction] = useState<GameAction | null>(null);
  const controlsRef = useRef(controls);
  controlsRef.current = controls;

  soundOnRef.current = soundOn;
  backgroundDivisorRef.current = backgroundDivisor;
  const roomXY = useMemo(() => ({ x: currentRoom % 16, y: Math.floor(currentRoom / 16) }), [currentRoom]);

  const applyCamera = useCallback((next: Camera) => {
    cameraRef.current = next;
    setCamera(next);
  }, []);

  const fitMap = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const scale = Math.min(viewport.clientWidth / MAP_WIDTH, viewport.clientHeight / MAP_HEIGHT);
    applyCamera({ scale, x: (viewport.clientWidth - MAP_WIDTH * scale) / 2, y: (viewport.clientHeight - MAP_HEIGHT * scale) / 2 });
  }, [applyCamera]);

  const focusRoom = useCallback((room?: number) => {
    const targetRoom = room ?? currentRoomRef.current;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const scale = Math.min(viewport.clientWidth / 256, viewport.clientHeight / 144) * 0.88;
    applyCamera({ scale, x: (viewport.clientWidth - 256 * scale) / 2 - (targetRoom % 16) * 256 * scale, y: (viewport.clientHeight - 144 * scale) / 2 - Math.floor(targetRoom / 16) * 144 * scale });
  }, [applyCamera]);

  const centerRoomKeepZoom = useCallback((room: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const c = cameraRef.current;
    const roomCenterX = (room % 16) * 256 + 128;
    const roomCenterY = Math.floor(room / 16) * 144 + 72;
    applyCamera({
      ...c,
      x: viewport.clientWidth / 2 - roomCenterX * c.scale,
      y: viewport.clientHeight / 2 - roomCenterY * c.scale,
    });
  }, [applyCamera]);

  useEffect(() => {
    try { localStorage.setItem(CONTROL_STORAGE_KEY, JSON.stringify(controls)); } catch { /* Storage may be unavailable. */ }
  }, [controls]);

  function startAudio() {
    if (audioRef.current.context) return;
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'square'; oscillator.frequency.value = 440; gain.gain.value = 0;
    oscillator.connect(gain); gain.connect(context.destination); oscillator.start();
    audioRef.current = { context, oscillator, gain };
  }
  function stopAudio() {
    const a = audioRef.current;
    if (a.oscillator) a.oscillator.stop();
    a.context?.close();
    audioRef.current = { context: null, oscillator: null, gain: null };
  }
  function playBeeper(events: Uint32Array, last: number) {
    const a = audioRef.current;
    if (!a.context || !a.gain) return;
    const now = a.context.currentTime + 0.004;
    if (events.length) {
      for (const packed of events) {
        const cycle = packed >>> 8;
        const value = packed & 255;
        a.gain.gain.setValueAtTime((value & 0x10) ? 0.035 : 0, now + Math.max(0, Math.min(0.02, cycle / 3500000)));
      }
    } else a.gain.gain.setTargetAtTime((last & 0x10) ? 0.035 : 0, now, 0.002);
  }

  const drawFrame = useCallback((message: Extract<WorkerMessage, { type: 'collected' }>) => {
    const canvas = mapCanvasRef.current;
    const ctx = canvas?.getContext('2d', { alpha: false });
    if (ctx) {
      const flashPhase = ((Math.floor(performance.now() / 320) & 1) === 1);
      for (const item of message.dirty) {
        const screen = new Uint8Array(item.screen);
        screenCacheRef.current[item.room] = screen;
        flashRoomsRef.current[item.room] = spectrumScreenHasFlash(screen);
      }
      if (flashPhase !== lastFlashPhaseRef.current) {
        for (let room = 0; room < screenCacheRef.current.length; room++) {
          const screen = screenCacheRef.current[room];
          if (screen && flashRoomsRef.current[room]) paintSpectrumRoom(ctx, room, screen, flashPhase);
        }
        lastFlashPhaseRef.current = flashPhase;
      } else {
        for (const item of message.dirty) {
          const screen = screenCacheRef.current[item.room];
          if (screen) paintSpectrumRoom(ctx, item.room, screen, flashPhase);
        }
      }
    }
    const previousRoom = currentRoomRef.current;
    if (message.currentRoom !== previousRoom) {
      currentRoomRef.current = message.currentRoom;
      setCurrentRoom(message.currentRoom);
      centerRoomKeepZoom(message.currentRoom);
    }
    if (soundOnRef.current) playBeeper(message.audioEvents, message.audioLast);
    const now = performance.now();
    const counter = fpsCounterRef.current;
    counter.frames++;
    if (!counter.started) counter.started = now;
    if (now - counter.started >= 1000) {
      setFps(counter.frames * 1000 / (now - counter.started));
      counter.frames = 0;
      counter.started = now;
    }
  }, [centerRoomKeepZoom]);

  const beginFrame = useCallback(() => {
    const workers = workersRef.current;
    if (!playingRef.current || !workers.length || frameStateRef.current) return;
    const id = ++frameIdRef.current;
    frameStateRef.current = { id, phase: 'begin', started: performance.now(), tickDone: new Set(), collectDone: new Set(), dirty: [], audioEvents: new Uint32Array(0), audioLast: 0, currentRoom: currentRoomRef.current };
    workers[0].postMessage({ type: 'begin', frameId: id });
  }, []);

  const handleWorkerMessage = useCallback((message: WorkerMessage) => {
    if (message.type === 'error') {
      setError(message.message); setStatus('Emulator error'); playingRef.current = false; setPlaying(false); frameStateRef.current = null; return;
    }
    if (message.type === 'module-ready') {
      moduleReadyRef.current.add(message.workerIndex);
      if (moduleReadyRef.current.size === message.workerCount) {
        poolReadyRef.current = true; setPoolReady(true); setWorkerCount(message.workerCount);
        setStatus(message.shared ? `Ready · ${message.workerCount} parallel WebAssembly workers` : 'Ready · single-worker compatibility mode');
      }
      return;
    }
    if (message.type === 'ready') {
      setReady(true); setRoomCount(message.roomCount); currentRoomRef.current = message.currentRoom; setCurrentRoom(message.currentRoom);
      setStatus('Emulator initialised. Ready to play.');
      requestAnimationFrame(() => fitMap());
      return;
    }
    const frame = frameStateRef.current;
    if (!frame || message.frameId !== frame.id) return;
    const workers = workersRef.current;
    if (message.type === 'begin-done' && frame.phase === 'begin') {
      frame.phase = 'tick';
      const viewport = viewportRef.current;
      const c = cameraRef.current;
      const left = viewport ? (0 - c.x) / c.scale : 0;
      const top = viewport ? (0 - c.y) / c.scale : 0;
      const right = viewport ? (viewport.clientWidth - c.x) / c.scale : MAP_WIDTH;
      const bottom = viewport ? (viewport.clientHeight - c.y) / c.scale : MAP_HEIGHT;
      const minCol = Math.max(0, Math.floor(left / 256));
      const maxCol = Math.min(15, Math.ceil(right / 256) - 1);
      const minRow = Math.max(0, Math.floor(top / 144));
      const maxRow = Math.min(31, Math.ceil(bottom / 144) - 1);
      for (const worker of workers) worker.postMessage({ type: 'tick', frameId: frame.id, backgroundDivisor: backgroundDivisorRef.current, minCol, maxCol, minRow, maxRow });
    } else if (message.type === 'tick-done' && frame.phase === 'tick') {
      frame.tickDone.add(message.workerIndex);
      if (frame.tickDone.size === workers.length) {
        frame.phase = 'collect';
        for (const worker of workers) worker.postMessage({ type: 'collect', frameId: frame.id });
      }
    } else if (message.type === 'collected' && frame.phase === 'collect') {
      frame.collectDone.add(message.workerIndex);
      frame.dirty.push(...message.dirty);
      if (message.workerIndex === 0) { frame.audioEvents = message.audioEvents; frame.audioLast = message.audioLast; }
      frame.currentRoom = message.currentRoom;
      if (frame.collectDone.size === workers.length) {
        const elapsed = performance.now() - frame.started;
        drawFrame({ ...message, dirty: frame.dirty, audioEvents: frame.audioEvents, audioLast: frame.audioLast, currentRoom: frame.currentRoom });
        if (performance.now() - telemetryUpdateRef.current >= 250) {
          setFrameMs(elapsed);
          telemetryUpdateRef.current = performance.now();
        }
        frameStateRef.current = null;
        if (playingRef.current) {
          const delay = Math.max(0, 20 - elapsed);
          frameTimerRef.current = setTimeout(beginFrame, delay);
        }
      }
    }
  }, [beginFrame, drawFrame, fitMap]);

  useEffect(() => {
    moduleReadyRef.current.clear(); poolReadyRef.current = false; setPoolReady(false);
    const shared = window.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
    const count = shared ? Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4)) : 1;
    const memory = shared ? new WebAssembly.Memory({ initial: 1024, maximum: 2048, shared: true }) : undefined;
    workerCountRef.current = count;
    const workers = Array.from({ length: count }, () => new Worker(new URL('./emu/emu.worker.ts', import.meta.url), { type: 'module' }));
    workersRef.current = workers;
    workers.forEach((worker, index) => {
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => handleWorkerMessage(event.data);
      worker.onerror = event => setError(event.message || 'Emulation worker failed');
      worker.postMessage({ type: 'module', memory, shared, workerIndex: index, workerCount: count });
    });
    if (!shared) setStatus('Loading Z80 emulator · single-worker mode (enable cross-origin isolation for parallel emulation)');
    return () => {
      if (frameTimerRef.current) clearTimeout(frameTimerRef.current);
      workers.forEach(worker => { worker.postMessage({ type: 'stop' }); worker.terminate(); });
      workersRef.current = []; stopAudio();
    };
  }, [handleWorkerMessage]);

  useEffect(() => {
    if (!poolReady) return;
    let cancelled = false;
    const loadBundledAssets = async () => {
      try {
        setStatus('Loading bundled Starquake snapshot and Spectrum ROM…');
        const base = import.meta.env.BASE_URL;
        const [snapshotResponse, romResponse] = await Promise.all([
          fetch(`${base}starquake.sna`),
          fetch(`${base}48.rom`),
        ]);
        if (!snapshotResponse.ok) throw new Error(`Could not load bundled snapshot (${snapshotResponse.status}).`);
        if (!romResponse.ok) throw new Error(`Could not load bundled Spectrum ROM (${romResponse.status}).`);
        const [snapshot, rom] = await Promise.all([snapshotResponse.arrayBuffer(), romResponse.arrayBuffer()]);
        if (snapshot.byteLength !== 49179) throw new Error(`Bundled snapshot must be 49,179 bytes; got ${snapshot.byteLength}.`);
        if (rom.byteLength < 16384) throw new Error(`Bundled Spectrum ROM must contain at least 16,384 bytes; got ${rom.byteLength}.`);
        if (cancelled) return;
        snapshotRef.current = snapshot;
        setSnapshotName('starquake.sna');
        setRomName('48.rom');
        setStatus('Initialising all 512 room states…');
        workersRef.current[0].postMessage({ type: 'init', snapshot, rom, cheats: false }, [snapshot, rom]);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setStatus('Could not load bundled game files');
        }
      }
    };
    loadBundledAssets();
    return () => { cancelled = true; };
  }, [poolReady]);

  useEffect(() => {
    const canvas = mapCanvasRef.current;
    const overlay = overlayRef.current;
    if (canvas && overlay) {
      canvas.width = MAP_WIDTH; canvas.height = MAP_HEIGHT;
      overlay.width = MAP_WIDTH; overlay.height = MAP_HEIGHT;
      const ctx = canvas.getContext('2d');
      if (ctx) { ctx.fillStyle = '#05080d'; ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT); }
    }
    fitMap();
    const observer = new ResizeObserver(() => fitMap());
    if (viewportRef.current) observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [fitMap]);

  useEffect(() => {
    const overlay = overlayRef.current;
    const ctx = overlay?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    ctx.strokeStyle = '#f7d66b'; ctx.lineWidth = 3;
    ctx.strokeRect(roomXY.x * 256 + 1.5, roomXY.y * 144 + 1.5, 253, 141);
    ctx.fillStyle = 'rgba(247,214,107,.10)';
    ctx.fillRect(roomXY.x * 256, roomXY.y * 144, 256, 144);
  }, [roomXY]);

  useEffect(() => {
    const publishKeys = () => {
      const rows = [...INITIAL_KEYS];
      for (const binding of controlsRef.current) {
        if (binding.code && pressedCodesRef.current.has(binding.code)) rows[binding.row] &= ~(1 << binding.bit);
      }
      keyRowsRef.current = rows;
      workersRef.current[0]?.postMessage({ type: 'keys', rows });
    };
    const onKey = (event: KeyboardEvent) => {
      const pending = captureActionRef.current;
      if (pending) {
        event.preventDefault();
        event.stopPropagation();
        if (event.code === 'Escape') {
          captureActionRef.current = null;
          setCapturingAction(null);
          return;
        }
        if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(event.code)) return;
        setControls(current => current.map(binding => {
          if (binding.action === pending) return { ...binding, code: event.code };
          if (binding.code === event.code) return { ...binding, code: '' };
          return binding;
        }));
        captureActionRef.current = null;
        setCapturingAction(null);
        pressedCodesRef.current.clear();
        publishKeys();
        return;
      }

      const binding = controlsRef.current.find(item => item.code && item.code === event.code);
      if (binding) {
        event.preventDefault();
        pressedCodesRef.current.add(event.code);
        publishKeys();
        return;
      }
      if (event.repeat) return;
      const key = event.key.toLowerCase();
      if (key === 'home') { event.preventDefault(); focusRoom(); }
      if (key === 'end') { event.preventDefault(); fitMap(); }
      if (key === '+' || key === '=') zoomAtCentre(1.25);
      if (key === '-' || key === '_') zoomAtCentre(0.8);
      if (key.startsWith('arrow')) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 80;
        const c = cameraRef.current;
        applyCamera({ ...c, x: c.x + (key === 'arrowleft' ? step : key === 'arrowright' ? -step : 0), y: c.y + (key === 'arrowup' ? step : key === 'arrowdown' ? -step : 0) });
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (captureActionRef.current) return;
      if (pressedCodesRef.current.delete(event.code)) publishKeys();
    };
    const clearPressed = () => {
      if (pressedCodesRef.current.size) {
        pressedCodesRef.current.clear();
        publishKeys();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearPressed);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearPressed);
    };
  }, [applyCamera, fitMap, focusRoom]);

  const zoomAt = (x: number, y: number, factor: number) => {
    const c = cameraRef.current; const scale = Math.max(0.025, Math.min(8, c.scale * factor));
    const wx = (x - c.x) / c.scale, wy = (y - c.y) / c.scale;
    applyCamera({ scale, x: x - wx * scale, y: y - wy * scale });
  };
  const zoomAtCentre = (factor: number) => {
    const viewport = viewportRef.current; if (!viewport) return;
    zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, factor);
  };
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault(); const rect = viewportRef.current!.getBoundingClientRect();
    zoomAt(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? 1.2 : 1 / 1.2);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { x: event.clientX, y: event.clientY, cameraX: cameraRef.current.x, cameraY: cameraRef.current.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return; const d = dragRef.current;
    applyCamera({ ...cameraRef.current, x: d.cameraX + event.clientX - d.x, y: d.cameraY + event.clientY - d.y });
  };
  const onPointerUp = () => { dragRef.current = null; };

  const loadRom = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    if (!poolReadyRef.current) { setError('The emulator workers are still loading. Try again in a moment.'); return; }
    if (!snapshotRef.current) { setError('Select a compatible Starquake 48K .sna snapshot first.'); return; }
    setError(''); setReady(false); playingRef.current = false; setPlaying(false); setStatus('Initialising all 512 room states…'); setRomName(file.name);
    const rom = await file.arrayBuffer();
    if (rom.byteLength < 16384) { setError('The Spectrum ROM file must contain at least 16,384 bytes.'); return; }
    const snapshot = snapshotRef.current.slice(0);
    workersRef.current[0].postMessage({ type: 'init', snapshot, rom, cheats }, [snapshot, rom]);
  };
  const loadSnapshot = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength !== 49179) { setError(`Expected an uncompressed 48K .sna snapshot of 49,179 bytes; got ${buffer.byteLength}.`); return; }
    snapshotRef.current = buffer; setSnapshotName(file.name); setError('');
    setReady(false); playingRef.current = false; setPlaying(false); setStatus('Snapshot selected. Select a compatible Spectrum ROM to initialise.');
  };
  const togglePlay = () => {
    if (!ready) return;
    if (playingRef.current) {
      playingRef.current = false; setPlaying(false); if (frameTimerRef.current) clearTimeout(frameTimerRef.current); setStatus('Paused');
    } else {
      playingRef.current = true; setPlaying(true); if (soundOnRef.current) startAudio(); setStatus('Running'); beginFrame();
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark">SQ</div><div><strong>STARQUAKE</strong><span>TILEMAP WEB EXPERIMENT</span></div></div>
        <div className="top-status"><span className={`status-dot ${playing ? 'live' : ready ? 'ready' : ''}`} />{status}</div>
        <div className="top-actions">
          <label className="file-button"><Upload size={15} /> ROM<input type="file" accept=".rom,.bin,.48k" onChange={loadRom} /></label>
          <label className="file-button secondary"><Upload size={15} /> SNAPSHOT<input type="file" accept=".sna" onChange={loadSnapshot} /></label>
          <label className="cheat-toggle"><input type="checkbox" checked={cheats} disabled={ready} onChange={(e: ChangeEvent<HTMLInputElement>) => setCheats(e.target.checked)} /> Cheats</label>
        </div>
      </header>

      <section className="toolbar">
        <div className="transport">
          <button className="primary-button" onClick={togglePlay} disabled={!ready}>{playing ? <Pause size={16} /> : <Play size={16} />}{playing ? 'Pause' : 'Play'}</button>
          <button className="icon-button" title="Focus current room (Home)" onClick={() => focusRoom()}><Crosshair size={16} /></button>
          <button className="icon-button" title="Fit entire map (End)" onClick={fitMap}><Scan size={16} /></button>
        </div>
        <div className="zoom-controls"><button className="icon-button" title="Zoom out" onClick={() => zoomAtCentre(0.8)}><Minus size={16} /></button><span>{Math.round(camera.scale * 100)}%</span><button className="icon-button" title="Zoom in" onClick={() => zoomAtCentre(1.25)}><Plus size={16} /></button><button className="icon-button" title="Reset view" onClick={fitMap}><RotateCcw size={15} /></button></div>
        <div className="toolbar-spacer" />
        <label className="rate-control">BACKGROUND <select value={backgroundDivisor} onChange={(e: ChangeEvent<HTMLSelectElement>) => setBackgroundDivisor(Number(e.target.value))}><option value={5}>10 Hz</option><option value={2}>25 Hz</option><option value={1}>50 Hz · full</option></select></label>
        <button className="icon-button sound-button" title={soundOn ? 'Mute' : 'Enable sound'} onClick={() => { const next = !soundOn; soundOnRef.current = next; setSoundOn(next); if (next) startAudio(); else stopAudio(); }}>{soundOn ? <Volume2 size={16} /> : <VolumeX size={16} />}</button>
        <div className="telemetry"><span>ROOM <b>{currentRoom.toString().padStart(3, '0')}</b></span><span>GRID <b>{roomXY.x},{roomXY.y}</b></span><span>ROOMS <b>{roomCount}</b></span><span>WORKERS <b>{workerCount}</b></span><span>FPS <b>{fps ? fps.toFixed(0) : '—'}</b></span><span>FRAME <b>{frameMs.toFixed(1)}ms</b></span></div>
      </section>

      <section className="workspace">
        <div className="map-viewport" ref={viewportRef} onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <div className="world" style={{ transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})` }}><canvas ref={mapCanvasRef} className="map-canvas" /><canvas ref={overlayRef} className="map-overlay" /></div>
          {!ready && <div className="empty-state"><div className="empty-chip">512 ROOMS · 16 × 32</div><h1>Starquake, room by room.</h1><p>The bundled Starquake snapshot and Spectrum ROM are loaded automatically to initialise the complete TileMap.</p><div className="empty-meta"><span>SNAPSHOT <b>{snapshotName}</b></span><span>ROM <b>{romName || 'Not loaded'}</b></span></div></div>}
        </div>
        <aside className="side-panel">
          <div className="panel-heading"><span>MAP INSPECTOR</span><span className="live-label">{playing ? 'RUNNING' : ready ? 'READY' : poolReady ? 'WAITING' : 'LOADING'}</span></div>
          <div className="active-room-card"><div className="room-label">ACTIVE ROOM</div><div className="room-number">{currentRoom.toString().padStart(3, '0')}</div><div className="room-coordinates">COLUMN {roomXY.x + 1} / 16 <i /> ROW {roomXY.y + 1} / 32</div></div>
          <div className="panel-section"><h3>EMULATION</h3><div className="metric"><span>CPU architecture</span><b>Zilog Z80</b></div><div className="metric"><span>Clock</span><b>3.5 MHz</b></div><div className="metric"><span>Frame rate target</span><b>50 Hz</b></div><div className="metric"><span>Virtual machines</span><b>512 room states</b></div><div className="metric"><span>Worker pool</span><b>{workerCount} thread{workerCount === 1 ? '' : 's'}</b></div><div className="metric"><span>Background update</span><b>{50 / backgroundDivisor} Hz</b></div><div className="metric"><span>Snapshot format</span><b>48K SNA</b></div></div>
          <div className="panel-section">
            <h3>CONTROLS <span className="control-hint">DOUBLE-CLICK A KEY TO CHANGE</span></h3>
            <div className="controls-config">
              {controls.map(binding => (
                <div className="config-control" key={binding.action}>
                  <span>{binding.label}</span>
                  <button
                    type="button"
                    className={`key-bind ${capturingAction === binding.action ? 'capturing' : ''}`}
                    onDoubleClick={() => { captureActionRef.current = binding.action; setCapturingAction(binding.action); }}
                    title="Double-click, then press the key you want to assign"
                  >{capturingAction === binding.action ? 'PRESS KEY…' : formatControlKey(binding.code)}</button>
                </div>
              ))}
            </div>
            <p className="control-help">{capturingAction ? 'Press a key to assign it. Press Escape to cancel.' : 'Double-click any key label, then press a new key.'}</p>
            <div className="control-row"><kbd>HOME</kbd><span>Focus active room</span><kbd>END</kbd><span>Fit map</span></div>
            <div className="control-row"><kbd>DRAG</kbd><span>Pan map</span><kbd>WHEEL</kbd><span>Zoom</span></div>
          </div>
          <div className="panel-footer">TileMap-style room emulation · Z80 WebAssembly · GPL-3.0</div>
        </aside>
      </section>
      {error && <div className="error-banner"><strong>Emulator:</strong> {error}<button onClick={() => setError('')}>Dismiss</button></div>}
      <footer className="footer"><span>STARQUAKE · 1985 · BUBBLE BUS SOFTWARE</span><span>Bundled Starquake snapshot · bundled Spectrum 48K ROM</span></footer>
    </main>
  );
}
