import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasmFiles = ['z80-single.wasm', 'z80-shared.wasm'].map(name => ({ name, bytes: fs.readFileSync(path.join(root, 'public', name)) }));
for (const wasm of wasmFiles) if (wasm.bytes.length < 10000) throw new Error(`${wasm.name} is unexpectedly small`);
console.log(`WebAssembly assets valid: ${wasmFiles.map(x => `${x.name}=${x.bytes.length} bytes`).join(', ')}.`);
console.log('Game snapshot and Spectrum 48K ROM are intentionally not bundled; select both locally in the browser.');
