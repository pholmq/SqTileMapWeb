/// <reference lib="webworker" />

type ModuleMessage = { type: 'module'; memory?: WebAssembly.Memory; shared: boolean; workerIndex: number; workerCount: number };
type InitMessage = { type: 'init'; snapshot: ArrayBuffer; rom: ArrayBuffer; cheats: boolean };
type KeyMessage = { type: 'keys'; rows: number[] };
type BeginMessage = { type: 'begin'; frameId: number };
type TickMessage = { type: 'tick'; frameId: number; backgroundDivisor: number; minCol: number; maxCol: number; minRow: number; maxRow: number };
type CollectMessage = { type: 'collect'; frameId: number };
type DebugMessage = { type: 'debug-capture'; captureId: number };
type Incoming = ModuleMessage | InitMessage | KeyMessage | BeginMessage | TickMessage | CollectMessage | DebugMessage | { type: 'stop' };

let wasm: WebAssembly.Exports | null = null;
let memory: WebAssembly.Memory | null = null;
let workerIndex = 0;
let workerCount = 1;
let shared = false;
let rangeStart = 0;
let rangeEnd = 512;
const scope = self as unknown as DedicatedWorkerGlobalScope;

async function loadModule(message: ModuleMessage) {
  workerIndex = message.workerIndex;
  workerCount = message.workerCount;
  shared = message.shared;
  rangeStart = Math.floor(512 * workerIndex / workerCount);
  rangeEnd = Math.floor(512 * (workerIndex + 1) / workerCount);
  const response = await fetch(shared ? '/z80-shared.wasm' : '/z80-single.wasm');
  if (!response.ok) throw new Error(`Could not load Z80 WebAssembly module (${response.status})`);
  const bytes = await response.arrayBuffer();
  let result: WebAssembly.WebAssemblyInstantiatedSource;
  if (shared) {
    if (!message.memory) throw new Error('Shared WebAssembly memory was not supplied.');
    memory = message.memory;
    result = await WebAssembly.instantiate(bytes, { env: { memory } });
  } else {
    result = await WebAssembly.instantiate(bytes, {});
    memory = result.instance.exports.memory as WebAssembly.Memory;
  }
  wasm = result.instance.exports;
  const e = wasm as Record<string, any>;
  if (shared) {
    const stackSize = 1024 * 1024;
    e.__stack_pointer.value = e.__stack_high.value - workerIndex * stackSize;
  }
  scope.postMessage({ type: 'module-ready', workerIndex, workerCount, shared, rangeStart, rangeEnd });
}

function initialise(message: InitMessage) {
  if (!wasm || !memory || workerIndex !== 0) throw new Error('Only worker 0 can initialise the shared Starquake machine.');
  const e = wasm as Record<string, any>;
  const heapBase = (e.__heap_base?.value ?? e.__data_end?.value ?? 0) + 1024;
  const snapshot = new Uint8Array(message.snapshot);
  const rom = new Uint8Array(message.rom);
  const snapshotPtr = heapBase;
  const romPtr = snapshotPtr + snapshot.byteLength + 16;
  const required = romPtr + rom.byteLength + 16;
  if (required > memory.buffer.byteLength) memory.grow(Math.ceil((required - memory.buffer.byteLength) / 65536));
  const heap = new Uint8Array(memory.buffer);
  heap.set(snapshot, snapshotPtr);
  heap.set(rom, romPtr);
  const code = e.emu_init(snapshotPtr, snapshot.byteLength, romPtr, rom.byteLength, message.cheats ? 1 : 0);
  if (code !== 0) {
    if (code <= -2) throw new Error(`Starquake snapshot does not match TileMap's expected hook at index ${-2 - code}.`);
    throw new Error('Snapshot must be an uncompressed 48K .sna file (49,179 bytes) and ROM must be at least 16 KB.');
  }
  scope.postMessage({ type: 'ready', roomCount: e.emu_room_count(), currentRoom: e.emu_current_room() });
}

function collect(frameId: number) {
  if (!wasm || !memory) return;
  const e = wasm as Record<string, any>;
  const heap = new Uint8Array(memory.buffer);
  const dirty: { room: number; screen: ArrayBuffer }[] = [];
  for (let room = rangeStart; room < rangeEnd; room++) {
    if (e.emu_take_dirty(room)) {
      const ptr = e.emu_screen_ptr(room) >>> 0;
      dirty.push({ room, screen: heap.slice(ptr, ptr + 6912).buffer });
    }
  }
  let audioEvents = new Uint32Array(0);
  let audioLast = 0;
  if (workerIndex === 0) {
    const count = Math.min(4096, e.emu_audio_count());
    if (count) audioEvents = new Uint32Array(memory.buffer, e.emu_audio_ptr() >>> 0, count).slice();
    audioLast = e.emu_audio_last();
  }
  scope.postMessage({ type: 'collected', frameId, workerIndex, dirty, audioEvents, audioLast, currentRoom: e.emu_current_room(), audioOverflow: workerIndex === 0 && e.emu_audio_overflowed() !== 0 }, [...dirty.map(x => x.screen), audioEvents.buffer as ArrayBuffer]);
}

scope.onmessage = (event: MessageEvent<Incoming>) => {
  const message = event.data;
  try {
    if (message.type === 'module') {
      loadModule(message).catch(error => scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }));
    } else if (message.type === 'init') {
      initialise(message);
    } else if (message.type === 'keys' && wasm) {
      const e = wasm as Record<string, any>;
      message.rows.forEach((value, row) => e.emu_set_key_row(row, value));
    } else if (message.type === 'begin' && wasm && workerIndex === 0) {
      (wasm as Record<string, any>).emu_begin_frame();
      scope.postMessage({ type: 'begin-done', frameId: message.frameId });
    } else if (message.type === 'tick' && wasm) {
      (wasm as Record<string, any>).emu_tick_range(rangeStart, rangeEnd, 50, message.frameId, message.backgroundDivisor, message.minCol, message.maxCol, message.minRow, message.maxRow);
      scope.postMessage({ type: 'tick-done', frameId: message.frameId, workerIndex });
    } else if (message.type === 'collect') {
      collect(message.frameId);
    } else if (message.type === 'debug-capture' && wasm && memory) {
      const e = wasm as Record<string, any>;
      const heap = new Uint8Array(memory.buffer);
      const ram = heap.slice(e.emu_debug_ram_ptr() >>> 0, (e.emu_debug_ram_ptr() >>> 0) + 49152);
      const writeCount = Math.max(0, e.emu_debug_write_count() | 0);
      const writeCapacity = e.emu_debug_write_capacity() | 0;
      const writeBytes = Math.min(writeCount, writeCapacity) * 8;
      const writePointer = e.emu_debug_write_ptr() >>> 0;
      const writes = new Uint8Array(writeBytes);
      const firstRecord = writeCount > writeCapacity ? writeCount % writeCapacity : 0;
      for (let i = 0; i < writeBytes; i++) {
        writes[i] = heap[writePointer + ((firstRecord * 8 + i) % (writeCapacity * 8))];
      }
      const result = {
        captureId: message.captureId,
        capturedAt: new Date().toISOString(),
        room: e.emu_current_room() | 0,
        pc: e.emu_debug_pc() & 0xffff,
        sp: e.emu_debug_sp() & 0xffff,
        writeCount,
        writeCapacity,
        ram: ram.buffer,
        writes: writes.buffer,
      };
      e.emu_debug_clear_writes();
      scope.postMessage({ type: 'debug-captured', ...result }, [ram.buffer, writes.buffer]);
    } else if (message.type === 'stop') {
      scope.close();
    }
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
