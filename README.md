# Starquake — TileMap Web experiment

A browser prototype based on the room-emulation architecture used by Simon Owen's TileMap. It uses the original Z80 CPU core compiled to WebAssembly, creates 512 independent Spectrum room states from the same 48K SNA snapshot, and renders their Spectrum screens into a single 16 × 32 world map.

> **Important:** No Starquake game snapshot or Spectrum ROM is bundled. You must supply both files locally in the browser: a compatible uncompressed 48K `.sna` snapshot (49,179 bytes) and a legally obtained 16 KB Spectrum 48K ROM. These copyrighted files are deliberately excluded from this public source project.

## Current implementation

- 512 room states, arranged as 16 columns × 32 rows.
- Each room has its own 64 KB address space and Z80 CPU state.
- Each room starts from the uploaded Starquake SNA and Spectrum 48K ROM.
- The original Starquake snapshot patches and TileMap hook addresses are applied and opcode-checked during initialisation.
- The active room is tracked globally. At the original room-change hook, the source room's full memory and CPU register state are copied into the destination room, then the destination becomes active. The source room's room number is restored, matching TileMap's room hand-off pattern.
- TileMap's inactive-room hooks are implemented: inactive sprite/attribute drawing is skipped, inactive BLOB falling is stopped, and inactive hazard handling is bypassed.
- A single map canvas displays the 512 room screens; the visible room area is cropped to the 144-pixel playfield below Starquake's 48-pixel status panel.
- Map camera supports continuous zoom, pointer-centred wheel zoom, drag pan, full-map fit, and focus on the active room.
- Spectrum keyboard matrix input for Starquake: Q/A/O/P/Space.
- Browser beeper output is a basic Web Audio approximation; it is not yet a cycle-accurate AY/48K audio implementation.
- Optional TileMap cheat pokes.

## Run locally

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal. Vite is configured with the cross-origin isolation headers needed for `SharedArrayBuffer` and parallel WebAssembly workers.

1. Wait for the Z80 workers to load.
2. Click **SNAPSHOT** and select your compatible uncompressed Starquake 48K `.sna` file (49,179 bytes).
3. Click **ROM** and select your legally obtained 16 KB Spectrum 48K ROM.
4. Click **Play**.

The browser uses a shared-memory worker pool when `crossOriginIsolated` is available. Each worker advances a disjoint range of rooms, while atomic room locks protect room-state copies during room transitions. Only rooms intersecting the current viewport are advanced, plus the active room. The default background update rate is 10 Hz while the active room is advanced every frame; you can select 25 Hz or full 50 Hz updates for all visible rooms in the toolbar. This is a deliberate browser-performance option: TileMap advances all visible rooms each frame, while a full 512-room browser simulation can be CPU-intensive. If the host does not provide cross-origin isolation, the app falls back to one worker.

## Build

```bash
npm run build
```

The output is in `dist/`.

For deployment, the host must send these response headers for the site and its same-origin resources:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The included `public/_headers` file is understood by several static hosts (including Netlify/Cloudflare Pages). Vite dev and preview servers set the headers automatically. GitHub Pages does not currently provide arbitrary response headers, so the parallel worker build will fall back to single-worker mode there.

## Rebuild the WebAssembly CPU

The prebuilt WASM files are committed in `public/`. To rebuild them with a Clang toolchain that supports `wasm32`:

```bash
npm run build:wasm
```

The script produces:

- `public/z80-single.wasm`: standalone linear memory, one worker.
- `public/z80-shared.wasm`: imported shared linear memory, atomics, one isolated stack per worker.

## Project structure

```text
public/
  z80-single.wasm      Single-worker Z80 core + room bridge
  z80-shared.wasm      Shared-memory Z80 core + room bridge
  _headers             COOP/COEP headers for static hosting
src/
  App.tsx              UI, map camera, worker orchestration
  spectrum.ts          ZX Spectrum bitmap/attribute renderer
  emu/
    Z80.c              Original Z80 CPU core from TileMap
    Z80.h
    Z80-support.h
    bridge.c           WebAssembly bridge and Starquake room hooks
    emu.worker.ts      Worker-side WASM module and room-range execution
scripts/
  build-wasm.sh
  validate-assets.mjs
```

## Controls

| Key / action | Effect |
|---|---|
| Q | Up |
| A | Down / create platform |
| O | Left |
| P | Right |
| Space | Fire |
| Mouse wheel | Zoom around pointer |
| Drag | Pan map |
| Home | Focus active room |
| End | Fit entire 16 × 32 map |
| + / - | Zoom in / out |
| Arrow keys | Pan map |

## Validation status and known limitations

The development snapshot used to build and validate the hook table was checked against all nine Starquake hook opcodes used by TileMap. The snapshot itself is not distributed in this repository. The WebAssembly bridge initialises all 512 room states in a local smoke test and reports the expected initial room (8). The shared-memory module was also instantiated in multiple workers against the same memory, and disjoint room ranges were executed concurrently in a smoke test. The project has **not yet been verified through a real game boot or room transition**, because a legally obtained Spectrum ROM was not available for a full boot test. Upload the correct 48K ROM and run the game to verify the hook hand-off in-browser.

The current bridge intentionally mirrors the TileMap CPU/memory and room-transfer model, but it is still a prototype. In particular:

- No Starquake SNA snapshot or Spectrum ROM is included; provide both locally.
- The SNA loader supports the uncompressed 48K `.sna` format used by the supplied file; compressed `.z80`/`.szx` snapshots are not supported.
- Beeper audio is approximate and does not yet include full timing-accurate sound synthesis.
- The map renderer uses the standard Spectrum palette; enhanced art replacement is a later layer.
- Some timing and synchronisation details need comparison against the native TileMap executable during gameplay testing.

## Licence

GPL-3.0. See `COPYING.txt` and `ATTRIBUTION.md`. The Starquake game snapshot is separately copyrighted material and is not relicensed by this repository.
