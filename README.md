# Starquake — TileMap Web experiment

A browser prototype based on the room-emulation architecture used by Simon Owen's TileMap. It uses the original Z80 CPU core compiled to WebAssembly, creates 512 independent Spectrum room states from the same 48K SNA snapshot, and renders their Spectrum screens into a single 16 × 32 world map.

**Play online:** [https://pholmq.github.io/SqTileMapWeb/](https://pholmq.github.io/SqTileMapWeb/)

> **Bundled game files:** The project includes `public/starquake.sna` (an uncompressed 48K snapshot, 49,179 bytes) and `public/48.rom` (a 16 KB Spectrum 48K ROM). The app loads both automatically at startup. These files remain subject to their original rights and are not covered by this project's GPL licence.

## Current implementation

- 512 room states, arranged as 16 columns × 32 rows.
- Each room has its own 64 KB address space and Z80 CPU state.
- Each room is initially seeded from the bundled Starquake SNA and Spectrum 48K ROM. A room keeps its own CPU and RAM state when revisited.
- The original Starquake snapshot patches and TileMap hook addresses are applied and opcode-checked during initialisation.
- The active room is tracked globally. On a room transition, a destination room is seeded from the source room only the first time it is entered; revisiting a room preserves its existing state.
- TileMap's inactive-room hooks are implemented: inactive sprite/attribute drawing is skipped, inactive BLOB falling is stopped, and inactive hazard handling is bypassed.
- A single map canvas displays the 512 room screens; the visible room area is cropped to the 144-pixel playfield below Starquake's 48-pixel status panel. The active room's 48-pixel status panel is shown separately as a HUD.
- Map camera supports continuous zoom, pointer-centred wheel zoom, drag pan, full-map fit, and focus on the active room.
- Default game controls are **W/A/S/D and Space**. The controls can be reassigned in the Controls panel.
- The emulator also passes through the physical ZX Spectrum keyboard matrix, allowing other Spectrum keys to be used where the game expects them.
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
2. The bundled snapshot and ROM are fetched automatically and used to initialise all 512 room states.
3. Click **Play**. The ROM and SNAPSHOT controls remain available if you want to load alternative files.

The browser uses a shared-memory worker pool when `crossOriginIsolated` is available. Each worker advances a disjoint range of rooms, while atomic room locks protect room-state copies during room transitions. The active room is advanced every frame. Visible background rooms are updated at a reduced rate (10 Hz by default); the toolbar lets you select 25 Hz or full 50 Hz updates for visible rooms. Previously visited rooms outside the viewport continue to receive staggered background updates at approximately 10 Hz. If the host does not provide cross-origin isolation, the app falls back to one worker.

## Controls

### Game controls

These are the default browser keyboard bindings. You can change them in the Controls panel.

| Keyboard key | Game action | ZX Spectrum key |
|---|---|---|
| W | Up | Q |
| S | Down / create platform | A |
| A | Left | O |
| D | Right | P |
| Space | Fire | M |

The Spectrum key column shows the corresponding key-matrix input sent to the emulated game. The browser keys in the first column are the keys to press with the default configuration.

### Map controls

| Key / action | Effect |
|---|---|
| Mouse wheel | Zoom around pointer |
| Drag | Pan map |
| Home | Focus active room |
| End | Fit entire 16 × 32 map |
| + / - | Zoom in / out |
| Arrow keys | Pan map |

## Build

```bash
npm run build
```

The output is in `dist/`.

For deployment to a host that supports cross-origin isolation, the host must send these response headers for the site and its same-origin resources:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The included `public/_headers` file is understood by several static hosts (including Netlify/Cloudflare Pages). Vite dev and preview servers set the headers automatically.

### GitHub Pages

The live site is [https://pholmq.github.io/SqTileMapWeb/](https://pholmq.github.io/SqTileMapWeb/). GitHub Pages does not currently provide the COOP/COEP response headers needed for cross-origin isolation, so the app uses its single-worker WebAssembly fallback there. The shared-memory worker build remains available on local or other hosting that supplies the required headers.

The GitHub Actions workflow builds the WebAssembly modules and web app, then deploys `dist/` to GitHub Pages when changes are pushed to `main`.

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

## Validation status and known limitations

The bundled snapshot is checked against the Starquake hook opcodes used by TileMap. The WebAssembly bridge initialises all 512 room states in a local smoke test and reports the expected initial room (8). The shared-memory module has also been instantiated in multiple workers against the same memory, and disjoint room ranges have been executed concurrently in a smoke test. Full gameplay and room-transition behaviour should still be tested in-browser.

The current bridge intentionally mirrors the TileMap CPU/memory and room-transfer model, but it is still a prototype. In particular:

- The SNA loader supports the uncompressed 48K `.sna` format used by the supplied file; compressed `.z80`/`.szx` snapshots are not supported.
- Beeper audio is approximate and does not yet include full timing-accurate sound synthesis.
- The map renderer uses the standard Spectrum palette; enhanced art replacement is a later layer.
- Some timing and synchronisation details need comparison against the native TileMap executable during gameplay testing.

## Licence

GPL-3.0. See `COPYING.txt` and `ATTRIBUTION.md`. The Starquake game snapshot and Spectrum ROM are separately copyrighted material and are not relicensed by this repository.
