import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bytes = fs.readFileSync(path.join(root, 'public/z80-shared.wasm'));
const memory = new WebAssembly.Memory({ initial: 1024, maximum: 2048, shared: true });
const instances = [];
for (let i = 0; i < 4; i++) {
  const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
  instance.exports.__stack_pointer.value = instance.exports.__stack_high.value - i * 1024 * 1024;
  instances.push(instance);
}
const e = instances[0].exports;
// Synthetic test-only SNA: it validates the WASM bridge and room allocator, not game boot.
const snapshot = Buffer.alloc(49179);
const hookTable = [[0x672d,0xcd],[0xa45f,0xcd],[0xa475,0xcd],[0xd9cb,0xcd],[0xd9ce,0xcd],[0xc747,0x3a],[0xc35e,0x21],[0xcbdc,0x7a],[0xa774,0x21]];
for (const [address, opcode] of hookTable) snapshot[27 + address - 0x4000] = opcode;
snapshot[23] = 0x00; snapshot[24] = 0x80; // SP=0x8000; synthetic return address is 0.

const testRom = Buffer.alloc(16384);
const input = e.__heap_base.value + 1024;
new Uint8Array(memory.buffer, input, snapshot.length).set(snapshot);
new Uint8Array(memory.buffer, input + snapshot.length + 16, testRom.length).set(testRom);
const result = e.emu_init(input, snapshot.length, input + snapshot.length + 16, testRom.length, 0);
if (result !== 0) throw new Error(`emu_init returned ${result}`);
if (e.emu_room_count() !== 512) throw new Error('Expected 512 room states');
if (instances[3].exports.emu_current_room() !== 8) throw new Error('Shared current-room state was not visible across instances');
for (let i = 0; i < 4; i++) instances[i].exports.emu_tick_range(i * 128, (i + 1) * 128, 1, 1, 5, 0, 15, 0, 31);
if (e.emu_room_id(511) !== 511) throw new Error('Room identity mapping failed');
if (!e.emu_take_dirty(8)) throw new Error('Active room did not expose a dirty Spectrum screen');
console.log('WASM smoke test passed: 4 shared instances, 512 room states, initial room 8, active-room frame and screen update.');
console.log('The dummy ROM in this test only validates the bridge; it does not boot Starquake.');
