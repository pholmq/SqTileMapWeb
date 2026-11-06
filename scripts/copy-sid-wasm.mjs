import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const packageDir = resolve('node_modules/libsidplayfp-wasm/dist');
const outputDir = resolve('public/sid-wasm');
await mkdir(outputDir, { recursive: true });

const assets = [
  'libsidplayfp.wasm',
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
  'MODIFICATIONS.md',
  'complete-source.tar.gz',
];

for (const asset of assets) {
  const source = resolve(packageDir, asset);
  const destination = resolve(outputDir, asset);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

console.log('Copied libsidplayfp WASM, licence notices and corresponding source to public/sid-wasm/');
