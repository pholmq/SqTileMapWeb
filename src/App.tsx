import { PointerEvent, WheelEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Minus, Pause, Play, Plus, Scan, Volume2, VolumeX, Crosshair } from 'lucide-react';
import { MAP_HEIGHT, MAP_WIDTH, paintSpectrumHud, paintSpectrumRoom, spectrumScreenHasFlash } from './spectrum';

const SPECTRUM_KEY_POSITIONS: Record<string, { row: number; bit: number }> = {
  ShiftLeft: { row: 0, bit: 0 }, ShiftRight: { row: 0, bit: 0 },
  KeyZ: { row: 0, bit: 1 }, KeyX: { row: 0, bit: 2 }, KeyC: { row: 0, bit: 3 }, KeyV: { row: 0, bit: 4 },
  KeyA: { row: 1, bit: 0 }, KeyS: { row: 1, bit: 1 }, KeyD: { row: 1, bit: 2 }, KeyF: { row: 1, bit: 3 }, KeyG: { row: 1, bit: 4 },
  KeyQ: { row: 2, bit: 0 }, KeyW: { row: 2, bit: 1 }, KeyE: { row: 2, bit: 2 }, KeyR: { row: 2, bit: 3 }, KeyT: { row: 2, bit: 4 },
  Digit1: { row: 3, bit: 0 }, Digit2: { row: 3, bit: 1 }, Digit3: { row: 3, bit: 2 }, Digit4: { row: 3, bit: 3 }, Digit5: { row: 3, bit: 4 },
  Numpad1: { row: 3, bit: 0 }, Numpad2: { row: 3, bit: 1 }, Numpad3: { row: 3, bit: 2 }, Numpad4: { row: 3, bit: 3 }, Numpad5: { row: 3, bit: 4 },
  Digit0: { row: 4, bit: 0 }, Digit9: { row: 4, bit: 1 }, Digit8: { row: 4, bit: 2 }, Digit7: { row: 4, bit: 3 }, Digit6: { row: 4, bit: 4 },
  Numpad0: { row: 4, bit: 0 }, Numpad9: { row: 4, bit: 1 }, Numpad8: { row: 4, bit: 2 }, Numpad7: { row: 4, bit: 3 }, Numpad6: { row: 4, bit: 4 },
  KeyP: { row: 5, bit: 0 }, KeyO: { row: 5, bit: 1 }, KeyI: { row: 5, bit: 2 }, KeyU: { row: 5, bit: 3 }, KeyY: { row: 5, bit: 4 },
  Enter: { row: 6, bit: 0 }, NumpadEnter: { row: 6, bit: 0 }, KeyL: { row: 6, bit: 1 }, KeyK: { row: 6, bit: 2 }, KeyJ: { row: 6, bit: 3 }, KeyH: { row: 6, bit: 4 },
  Space: { row: 7, bit: 0 }, KeyM: { row: 7, bit: 2 }, KeyN: { row: 7, bit: 3 }, KeyB: { row: 7, bit: 4 },
};

type WorkerMessage =
  | { type: 'module-ready'; workerIndex: number; workerCount: number; shared: boolean; rangeStart: number; rangeEnd: number }
  | { type: 'ready'; roomCount: number; currentRoom: number }
  | { type: 'error'; message: string }
  | { type: 'debug-error'; message: string }
  | { type: 'debug-captured'; captureId: number; capturedAt: string; room: number; pc: number; sp: number; writeTraceAvailable: boolean; writeCount: number; writeCapacity: number; ram: ArrayBuffer; writes: ArrayBuffer }
  | { type: 'begin-done'; frameId: number }
  | { type: 'tick-done'; frameId: number; workerIndex: number }
  | { type: 'collected'; frameId: number; workerIndex: number; dirty: { room: number; screen: ArrayBuffer }[]; audioEvents: Uint32Array; audioLast: number; currentRoom: number; gameOver: boolean; audioOverflow: boolean };

type Camera = { scale: number; x: number; y: number };
type FrameState = { id: number; phase: 'begin' | 'tick' | 'collect'; started: number; tickDone: Set<number>; collectDone: Set<number>; dirty: { room: number; screen: ArrayBuffer }[]; audioEvents: Uint32Array; audioLast: number; currentRoom: number; gameOver: boolean };

const INITIAL_KEYS = [255, 255, 255, 255, 255, 255, 255, 255];
type GameAction = 'up' | 'down' | 'left' | 'right' | 'fire';
type ControlBinding = { action: GameAction; label: string; code: string; row: number; bit: number };

const DEFAULT_CONTROLS: ControlBinding[] = [
  { action: 'up', label: 'Up', code: 'KeyW', row: 2, bit: 0 },
  { action: 'down', label: 'Down / platform', code: 'KeyS', row: 1, bit: 0 },
  { action: 'left', label: 'Left', code: 'KeyA', row: 5, bit: 1 },
  { action: 'right', label: 'Right', code: 'KeyD', row: 5, bit: 0 },
  { action: 'fire', label: 'Fire', code: 'Space', row: 7, bit: 2 },
];

const ROOM_FOCUS_DURATION_MS = 1150;
const DEFAULT_ZOOM_SCALE = 2.11;
const BACKGROUND_DIVISOR = 2;
const SPECTRUM_FRAME_CYCLES = 70000;
const CONTROL_STORAGE_KEY = 'starquake-controls-v4';

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
  const hudCanvasRef = useRef<HTMLCanvasElement>(null);
  const workersRef = useRef<Worker[]>([]);
  const poolReadyRef = useRef(false);
  const moduleReadyRef = useRef(new Set<number>());
  const cameraRef = useRef<Camera>({ scale: DEFAULT_ZOOM_SCALE, x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; cameraX: number; cameraY: number } | null>(null);
  const keyRowsRef = useRef<number[]>([...INITIAL_KEYS]);
  const pressedCodesRef = useRef(new Set<string>());
  const captureActionRef = useRef<GameAction | null>(null);
  const flashRoomsRef = useRef<boolean[]>(Array(512).fill(false));
  const visitedRoomsRef = useRef<boolean[]>(Array(512).fill(false));
  const visitedAtRef = useRef<number[]>(Array(512).fill(0));
  const audioRef = useRef<{ context: AudioContext | null; nextTime: number; lastLevel: boolean; lowPass: number; previousInput: number; highPass: number }>({ context: null, nextTime: 0, lastLevel: false, lowPass: 0, previousInput: 0, highPass: 0 });
  const frameStateRef = useRef<FrameState | null>(null);
  const frameIdRef = useRef(0);
  /* Room entered on the previous frame; its screen is always re-sent on the next frame. */
  const forceRoomRef = useRef(-1);
  const currentRoomRef = useRef(8);
  const screenCacheRef = useRef<(Uint8Array | null)[]>(Array(512).fill(null));
  const lastFlashPhaseRef = useRef(false);
  const frameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasAutoPreviewedRef = useRef(false);
  const playingRef = useRef(false);
  const hasStartedRef = useRef(false);
  const soundOnRef = useRef(true);

  const [camera, setCamera] = useState<Camera>(cameraRef.current);
  const worldRef = useRef<HTMLDivElement>(null);
  const cameraAnimationRef = useRef<number | null>(null);
  const [status, setStatus] = useState('Preparing browser emulator…');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [poolReady, setPoolReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [currentRoom, setCurrentRoom] = useState(8);
  const [visitedVersion, setVisitedVersion] = useState(0);
  const [debugCapturePending, setDebugCapturePending] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [keyboardMode, setKeyboardMode] = useState<'mapped' | 'spectrum'>('mapped');
  const keyboardModeRef = useRef<'mapped' | 'spectrum'>('mapped');
  const [controls, setControls] = useState<ControlBinding[]>(readControls);
  const [capturingAction, setCapturingAction] = useState<GameAction | null>(null);
  const controlsRef = useRef(controls);
  
  controlsRef.current = controls;
  soundOnRef.current = soundOn;

  const applyCamera = useCallback((next: Camera) => {
    if (cameraAnimationRef.current !== null) {
      cancelAnimationFrame(cameraAnimationRef.current);
      cameraAnimationRef.current = null;
    }
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
    const scale = DEFAULT_ZOOM_SCALE;
    applyCamera({ scale, x: (viewport.clientWidth - 256 * scale) / 2 - (targetRoom % 16) * 256 * scale, y: (viewport.clientHeight - 144 * scale) / 2 - Math.floor(targetRoom / 16) * 144 * scale });
  }, [applyCamera]);

  const centerRoomKeepZoom = useCallback((room: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (cameraAnimationRef.current !== null) cancelAnimationFrame(cameraAnimationRef.current);
    const start = cameraRef.current;
    const roomCenterX = (room % 16) * 256 + 128;
    const roomCenterY = Math.floor(room / 16) * 144 + 72;
    const targetX = viewport.clientWidth / 2 - roomCenterX * start.scale;
    const targetY = viewport.clientHeight / 2 - roomCenterY * start.scale;
    const startedAt = performance.now();
    const animate = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / ROOM_FOCUS_DURATION_MS);
      const eased = progress * progress * (3 - 2 * progress);
      const next = { ...start, x: start.x + (targetX - start.x) * eased, y: start.y + (targetY - start.y) * eased };
      cameraRef.current = next;
      if (worldRef.current) worldRef.current.style.transform = `translate3d(${next.x}px, ${next.y}px, 0) scale(${next.scale})`;
      if (progress < 1) cameraAnimationRef.current = requestAnimationFrame(animate);
      else {
        cameraAnimationRef.current = null;
        cameraRef.current = { ...start, x: targetX, y: targetY };
        setCamera(cameraRef.current);
      }
    };
    cameraAnimationRef.current = requestAnimationFrame(animate);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(CONTROL_STORAGE_KEY, JSON.stringify(controls)); } catch { /* Storage may be unavailable. */ }
  }, [controls]);

  useEffect(() => {
    const unlock = () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      if (playingRef.current && soundOnRef.current) startAudio();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  function startAudio() {
    const existing = audioRef.current.context;
    if (existing) { void existing.resume(); return; }
    const context = new AudioContext();
    audioRef.current = { context, nextTime: context.currentTime + 0.01, lastLevel: false, lowPass: 0, previousInput: 0, highPass: 0 };
    void context.resume();
  }

  function stopAudio() {
    const context = audioRef.current.context;
    if (context) void context.close();
    audioRef.current = { context: null, nextTime: 0, lastLevel: false, lowPass: 0, previousInput: 0, highPass: 0 };
  }

  function playBeeper(events: Uint32Array, last: number) {
    const audio = audioRef.current;
    const context = audio.context;
    if (!context) return;
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
    const sampleRate = context.sampleRate;
    const sampleCount = Math.max(1, Math.round(sampleRate * totalCycles / 3500000));
    const frameDuration = sampleCount / sampleRate;
    const buffer = context.createBuffer(1, sampleCount, sampleRate);
    const samples = buffer.getChannelData(0);
    let level = audio.lastLevel;
    let eventIndex = 0;
    let nextCycle = eventCycles.length ? eventCycles[0] : Infinity;
    const sampleCycles = totalCycles / sampleCount;
    const lowPassCoefficient = 1 - Math.exp(-2 * Math.PI * 4800 / sampleRate);
    const highPassCoefficient = Math.exp(-2 * Math.PI * 35 / sampleRate);
    let lowPass = audio.lowPass;
    let previousInput = audio.previousInput;
    let highPass = audio.highPass;
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
      samples[sample] = highPass;
    }
    audio.lastLevel = (last & 0x10) !== 0;
    audio.lowPass = lowPass;
    audio.previousInput = previousInput;
    audio.highPass = highPass;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.004, audio.nextTime);
    source.start(startAt);
    audio.nextTime = startAt + frameDuration;
    source.onended = () => source.disconnect();
  }

  const drawFrame = useCallback((message: Extract<WorkerMessage, { type: 'collected' }>) => {
    const canvas = mapCanvasRef.current;
    const ctx = canvas?.getContext('2d', { alpha: false });
    const previousRoom = currentRoomRef.current;
    
    let staleRoom = -1;
    if (message.currentRoom !== previousRoom) {
      staleRoom = message.currentRoom;
      forceRoomRef.current = message.currentRoom;
      if (hasStartedRef.current) {
        if (!visitedRoomsRef.current[previousRoom]) {
          visitedRoomsRef.current[previousRoom] = true;
          visitedAtRef.current[previousRoom] = performance.now();
          setVisitedVersion(version => version + 1);
        }
        if (!visitedRoomsRef.current[message.currentRoom]) {
          screenCacheRef.current[message.currentRoom] = null;
          flashRoomsRef.current[message.currentRoom] = false;
          if (ctx) {
            ctx.fillStyle = '#05080d';
            ctx.fillRect((message.currentRoom % 16) * 256, Math.floor(message.currentRoom / 16) * 144, 256, 144);
          }
        }
      }
      currentRoomRef.current = message.currentRoom;
      setCurrentRoom(message.currentRoom);
      centerRoomKeepZoom(message.currentRoom);
    }

    if (ctx) {
      const flashPhase = ((Math.floor(performance.now() / 320) & 1) === 1);
      for (const item of message.dirty) {
        if (item.room === staleRoom) continue;
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
          if (item.room === staleRoom) continue;
          const screen = screenCacheRef.current[item.room];
          if (screen) paintSpectrumRoom(ctx, item.room, screen, flashPhase);
        }
      }
    }

    const hud = hudCanvasRef.current?.getContext('2d');
    const activeScreen = screenCacheRef.current[message.currentRoom];
    if (hud) {
      if (activeScreen && staleRoom < 0) paintSpectrumHud(hud, activeScreen);
      else if (staleRoom < 0) hud.clearRect(0, 0, 256, 48); 
    }
    
    if (staleRoom < 0 && forceRoomRef.current >= 0) forceRoomRef.current = -1;

    if (message.gameOver) {
      if (initialPreviewTimerRef.current) clearTimeout(initialPreviewTimerRef.current);
      initialPreviewTimerRef.current = null;
      if (frameTimerRef.current) clearTimeout(frameTimerRef.current);
      frameTimerRef.current = null;
      playingRef.current = false;
      setPlaying(false);
      setGameOver(true);
      setStatus('Game over · all lives lost');
    }

    if (soundOnRef.current) playBeeper(message.audioEvents, message.audioLast);
  }, [centerRoomKeepZoom]);

  const beginFrame = useCallback(() => {
    const workers = workersRef.current;
    if (!playingRef.current || !workers.length || frameStateRef.current) return;
    const id = ++frameIdRef.current;
    frameStateRef.current = { id, phase: 'begin', started: performance.now(), tickDone: new Set(), collectDone: new Set(), dirty: [], audioEvents: new Uint32Array(0), audioLast: 0, currentRoom: currentRoomRef.current, gameOver: false };
    workers[0].postMessage({ type: 'begin', frameId: id });
  }, []);

  const handleWorkerMessage = useCallback((message: WorkerMessage) => {
    if (message.type === 'debug-error') {
      setDebugCapturePending(false);
      setError(message.message);
      return;
    }
    if (message.type === 'debug-captured') {
      const ram = new Uint8Array(message.ram);
      const writeBytes = new Uint8Array(message.writes);
      const view = new DataView(writeBytes.buffer, writeBytes.byteOffset, writeBytes.byteLength);
      const writes = Array.from({ length: Math.floor(writeBytes.byteLength / 8) }, (_, index) => {
        const offset = index * 8;
        return {
          pc: view.getUint16(offset, true),
          address: view.getUint16(offset + 2, true),
          frameCycle: view.getUint16(offset + 4, true),
          before: view.getUint8(offset + 6),
          after: view.getUint8(offset + 7),
        };
      });
      const diagnostic = {
        format: 'Starquake emulator diagnostic v1',
        capturedAt: message.capturedAt,
        room: message.room,
        pc: message.pc,
        sp: message.sp,
        ramStart: '0x4000',
        ramEnd: '0xffff',
        ramHex: Array.from(ram, value => value.toString(16).padStart(2, '0')).join(''),
        writeTraceAvailable: message.writeTraceAvailable,
        writeCountSincePreviousCapture: message.writeCount,
        writeLogTruncated: message.writeCount > message.writeCapacity,
        writes,
      };
      const blob = new Blob([JSON.stringify(diagnostic, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `starquake-diagnostic-room-${message.room}-${message.captureId}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setDebugCapturePending(false);
      setStatus(`Diagnostic captured · room ${message.room}`);
      return;
    }
    if (message.type === 'error') {
      setDebugCapturePending(false); setError(message.message); setStatus('Emulator error'); playingRef.current = false; setPlaying(false); frameStateRef.current = null; return;
    }
    if (message.type === 'module-ready') {
      moduleReadyRef.current.add(message.workerIndex);
      if (moduleReadyRef.current.size === message.workerCount) {
        poolReadyRef.current = true; setPoolReady(true);
        setStatus(message.shared ? `Ready · ${message.workerCount} parallel WebAssembly workers` : 'Ready · single-worker compatibility mode');
      }
      return;
    }
    if (message.type === 'ready') {
      setReady(true); setGameOver(false); setRestarting(false); currentRoomRef.current = message.currentRoom; setCurrentRoom(message.currentRoom); hasStartedRef.current = false; visitedRoomsRef.current.fill(false); visitedAtRef.current.fill(0); screenCacheRef.current.fill(null); flashRoomsRef.current.fill(false); setVisitedVersion(version => version + 1);
      const map = mapCanvasRef.current?.getContext('2d');
      if (map) { map.fillStyle = '#05080d'; map.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT); }
      const hud = hudCanvasRef.current?.getContext('2d');
      if (hud) hud.clearRect(0, 0, 256, 48);
      setStatus('Emulator initialised. Showing startup graphics…');
      requestAnimationFrame(() => {
        const viewport = viewportRef.current;
        if (viewport) {
          const scale = DEFAULT_ZOOM_SCALE;
          const room = message.currentRoom;
          const roomCenterX = (room % 16) * 256 + 128;
          const roomCenterY = Math.floor(room / 16) * 144 + 72;
          applyCamera({ scale, x: viewport.clientWidth / 2 - roomCenterX * scale, y: viewport.clientHeight / 2 - roomCenterY * scale });
        }
        if (!hasAutoPreviewedRef.current) {
          hasAutoPreviewedRef.current = true;
          hasStartedRef.current = true;
          playingRef.current = true;
          setPlaying(true);
          setStatus('Running');
          beginFrame();
        }
      });
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
      for (const worker of workers) worker.postMessage({ type: 'tick', frameId: frame.id, backgroundDivisor: BACKGROUND_DIVISOR, minCol, maxCol, minRow, maxRow });
    } else if (message.type === 'tick-done' && frame.phase === 'tick') {
      frame.tickDone.add(message.workerIndex);
      if (frame.tickDone.size === workers.length) {
        frame.phase = 'collect';
        for (const worker of workers) worker.postMessage({ type: 'collect', frameId: frame.id, forceRoom: forceRoomRef.current });
      }
    } else if (message.type === 'collected' && frame.phase === 'collect') {
      frame.collectDone.add(message.workerIndex);
      frame.dirty.push(...message.dirty);
      if (message.workerIndex === 0) { frame.audioEvents = message.audioEvents; frame.audioLast = message.audioLast; }
      frame.currentRoom = message.currentRoom;
      frame.gameOver = frame.gameOver || message.gameOver;
      if (frame.collectDone.size === workers.length) {
        const elapsed = performance.now() - frame.started;
        drawFrame({ ...message, dirty: frame.dirty, audioEvents: frame.audioEvents, audioLast: frame.audioLast, currentRoom: frame.currentRoom, gameOver: frame.gameOver });
        frameStateRef.current = null;
        if (playingRef.current) {
          const delay = Math.max(0, 20 - elapsed);
          frameTimerRef.current = setTimeout(beginFrame, delay);
        }
      }
    }
  }, [beginFrame, drawFrame, fitMap, applyCamera]);

  useEffect(() => {
    moduleReadyRef.current.clear(); poolReadyRef.current = false; setPoolReady(false);
    const shared = window.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
    const count = shared ? Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4)) : 1;
    const memory = shared ? new WebAssembly.Memory({ initial: 1024, maximum: 2048, shared: true }) : undefined;
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
      if (initialPreviewTimerRef.current) clearTimeout(initialPreviewTimerRef.current);
      workers.forEach(worker => { worker.postMessage({ type: 'stop' }); worker.terminate(); });
      if (cameraAnimationRef.current !== null) cancelAnimationFrame(cameraAnimationRef.current);
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
      if (hudCanvasRef.current) {
        hudCanvasRef.current.width = 256;
        hudCanvasRef.current.height = 48;
      }
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
    const fadeDuration = 900;
    let animation = 0;
    const draw = () => {
      ctx.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
      const now = performance.now();
      let fading = false;
      for (let room = 0; room < 512; room++) {
        if (!visitedRoomsRef.current[room] || room === currentRoom) continue;
        const started = visitedAtRef.current[room] || now;
        const progress = Math.min(1, Math.max(0, (now - started) / fadeDuration));
        if (progress < 1) fading = true;
        ctx.fillStyle = `rgba(190,200,215,${0.10 * progress})`;
        ctx.fillRect((room % 16) * 256, Math.floor(room / 16) * 144, 256, 144);
      }
      if (fading) animation = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(animation);
  }, [currentRoom, visitedVersion]);

  useEffect(() => {
    const publishKeys = () => {
      const rows = [...INITIAL_KEYS];
      for (const code of pressedCodesRef.current) {
        const binding = controlsRef.current.find(item => item.code && item.code === code);
        const nativePosition = SPECTRUM_KEY_POSITIONS[code];
        const positions = keyboardModeRef.current === 'spectrum'
          ? [nativePosition].filter((position): position is { row: number; bit: number } => Boolean(position))
          : binding ? [binding] : [nativePosition].filter((position): position is { row: number; bit: number } => Boolean(position));
        for (const position of positions) rows[position.row] &= ~(1 << position.bit);
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
      if (event.code === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        const next = keyboardModeRef.current === 'mapped' ? 'spectrum' : 'mapped';
        keyboardModeRef.current = next;
        setKeyboardMode(next);
        pressedCodesRef.current.clear();
        keyRowsRef.current = [...INITIAL_KEYS];
        workersRef.current[0]?.postMessage({ type: 'keys', rows: [...INITIAL_KEYS] });
        return;
      }
      const binding = controlsRef.current.find(item => item.code && item.code === event.code);
      if (keyboardModeRef.current === 'spectrum' ? Boolean(SPECTRUM_KEY_POSITIONS[event.code]) : Boolean(binding || SPECTRUM_KEY_POSITIONS[event.code])) {
        event.preventDefault();
        if (!event.repeat || !pressedCodesRef.current.has(event.code)) {
          pressedCodesRef.current.add(event.code);
          publishKeys();
        }
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
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', clearPressed);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
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
  
  const toggleKeyboardMode = () => {
    const next = keyboardModeRef.current === 'mapped' ? 'spectrum' : 'mapped';
    keyboardModeRef.current = next;
    setKeyboardMode(next);
    pressedCodesRef.current.clear();
    keyRowsRef.current = [...INITIAL_KEYS];
    workersRef.current[0]?.postMessage({ type: 'keys', rows: [...INITIAL_KEYS] });
  };
  
  const togglePlay = () => {
    if (!ready || gameOver || restarting) return;
    if (initialPreviewTimerRef.current) clearTimeout(initialPreviewTimerRef.current);
    initialPreviewTimerRef.current = null;
    if (playingRef.current) {
      playingRef.current = false; setPlaying(false); if (frameTimerRef.current) clearTimeout(frameTimerRef.current); setStatus('Paused');
    } else {
      if (!hasStartedRef.current) {
        visitedRoomsRef.current.fill(false);
        visitedAtRef.current.fill(0);
        setVisitedVersion(version => version + 1);
        hasStartedRef.current = true;
      }
      playingRef.current = true; setPlaying(true); if (soundOnRef.current) startAudio(); setStatus('Running'); beginFrame();
    }
  };
  
  const restartGame = async () => {
    if (!ready || restarting) return;
    playingRef.current = false;
    setPlaying(false);
    if (frameTimerRef.current) clearTimeout(frameTimerRef.current);
    if (initialPreviewTimerRef.current) clearTimeout(initialPreviewTimerRef.current);
    initialPreviewTimerRef.current = null;
    frameStateRef.current = null;
    setReady(false);
    setRestarting(true);
    setError('');
    setStatus('Restarting Starquake…');
    try {
      const base = import.meta.env.BASE_URL;
      const [snapshotResponse, romResponse] = await Promise.all([fetch(`${base}starquake.sna`), fetch(`${base}48.rom`)]);
      if (!snapshotResponse.ok) throw new Error(`Could not load bundled snapshot (${snapshotResponse.status}).`);
      if (!romResponse.ok) throw new Error(`Could not load bundled Spectrum ROM (${romResponse.status}).`);
      const [snapshot, rom] = await Promise.all([snapshotResponse.arrayBuffer(), romResponse.arrayBuffer()]);
      if (snapshot.byteLength !== 49179) throw new Error(`Bundled snapshot must be 49,179 bytes; got ${snapshot.byteLength}.`);
      if (rom.byteLength < 16384) throw new Error(`Bundled Spectrum ROM must contain at least 16,384 bytes; got ${rom.byteLength}.`);
      const worker = workersRef.current[0];
      if (!worker) throw new Error('The emulator worker is unavailable. Reload the page to initialise it again.');
      worker.postMessage({ type: 'init', snapshot, rom, cheats: false }, [snapshot, rom]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus('Could not restart the game');
      setReady(true);
      setRestarting(false);
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><img className="brand-blob" src={`${import.meta.env.BASE_URL}blob.svg`} alt="BLOB" /><div><strong>STARQUAKE</strong><span>TILEMAP WEB EXPERIMENT</span></div></div>
        <div className="header-controls">
          <div className="transport">
            <button className="primary-button" onClick={gameOver ? restartGame : togglePlay} disabled={!ready || restarting}>{gameOver ? <Play size={16} /> : playing ? <Pause size={16} /> : <Play size={16} />}{restarting ? 'Restarting…' : gameOver ? 'Restart' : playing ? 'Pause' : 'Play'}</button>
            <button className="icon-button" title="Focus current room (Home)" onClick={() => focusRoom()}><Crosshair size={16} /></button>
            <button className="icon-button" title="Fit entire map (End)" onClick={fitMap}><Scan size={16} /></button>
          </div>
          <div className="zoom-controls"><button className="icon-button" title="Zoom out" onClick={() => zoomAtCentre(0.8)}><Minus size={16} /></button><span>{Math.round(camera.scale / DEFAULT_ZOOM_SCALE * 100)}%</span><button className="icon-button" title="Zoom in" onClick={() => zoomAtCentre(1.25)}><Plus size={16} /></button></div>
          <button className="icon-button sound-button" title={soundOn ? 'Mute' : 'Enable sound'} onClick={() => { const next = !soundOn; soundOnRef.current = next; setSoundOn(next); if (next) startAudio(); else stopAudio(); }}>{soundOn ? <Volume2 size={16} /> : <VolumeX size={16} />}</button>
        </div>
      </header>
      <section className="workspace">
        <div className="game-view">
          <div className="hud-strip"><canvas ref={hudCanvasRef} className="hud-canvas" aria-label="Starquake game HUD" /></div>
          <div className="map-viewport" ref={viewportRef} onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            <div ref={worldRef} className="world" style={{ transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})` }}><canvas ref={mapCanvasRef} className="map-canvas" /><canvas ref={overlayRef} className="map-overlay" /></div>
          </div>
        </div>
        <aside className="side-panel">
          <div className="panel-section">
            <h3>CONTROLS <span className="control-hint">CUSTOMISE KEY BINDINGS</span></h3>
            <div className="controls-config">
              {controls.map(binding => (
                <div className="config-control" key={binding.action}>
                  <span className="control-action">{binding.label}</span>
                  <kbd className="key-value">{capturingAction === binding.action ? 'PRESS KEY…' : formatControlKey(binding.code)}</kbd>
                  <button
                    type="button"
                    className={`edit-bind ${capturingAction === binding.action ? 'capturing' : ''}`}
                    onClick={() => {
                      captureActionRef.current = binding.action;
                      setCapturingAction(binding.action);
                    }}
                  >{capturingAction === binding.action ? 'WAITING' : 'Edit'}</button>
                </div>
              ))}
            </div>
            <p className="control-help">{capturingAction ? 'Press the new key. Press Escape to cancel.' : 'Select Edit, then press the key to assign.'}</p>
            <div className="control-row"><kbd>HOME</kbd><span>Focus active room</span><kbd>END</kbd><span>Fit map</span></div>
            <div className="control-row"><kbd>DRAG</kbd><span>Pan map</span><kbd>WHEEL</kbd><span>Zoom</span></div>
          </div>
          
          <div className="panel-section">
            <h3>TELEPORTER CODES</h3>
            <div className="teleporter-codes">
              <span>EXIAL</span><span>VEROX</span>
              <span>RAMIX</span><span>TULSA</span>
              <span>ASOIC</span><span>DELTA</span>
              <span>ALGOL</span><span>KYZIA</span>
              <span>ULTRA</span><span>IRAGE</span>
              <span>OKTUP</span><span>SONIQ</span>
              <span>AMIGA</span><span>AMAHA</span>
              <span className="core-code">QUAKE <i>(Core)</i></span>
            </div>
            <p className="control-help" style={{ marginTop: '16px', textAlign: 'center', fontWeight: 700, fontSize: '12px', color: '#dce5f2' }}>SWITCH TO KEYBOARD WHEN ENTERING TELEPORTER CODES</p>
            <button className="keyboard-mode-button full-width" title="Switch between mapped controls and the original Spectrum keyboard (Tab)" onClick={toggleKeyboardMode}>
              {keyboardMode === 'mapped' ? 'MODE: CONTROLS' : 'MODE: KEYBOARD'}
            </button>
          </div>
        </aside>
      </section>
      {error && <div className="error-banner"><strong>Emulator:</strong> {error}<button onClick={() => setError('')}>Dismiss</button></div>}
    </main>
  );
}