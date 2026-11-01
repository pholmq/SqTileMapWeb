#!/usr/bin/env sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
EMU="$ROOT/src/emu"
OUT="$ROOT/public"
CLANG="${CLANG:-clang}"
mkdir -p "$OUT" "$ROOT/.build"

COMMON="--target=wasm32 -O3 -flto -DCPU_Z80_USE_LOCAL_HEADER -DCPU_Z80_DEPENDENCIES_H=\"Z80-support.h\""

# Single-worker fallback for hosts that do not enable cross-origin isolation.
$CLANG $COMMON -c "$EMU/Z80.c" -o "$ROOT/.build/Z80-single.o"
$CLANG $COMMON -c "$EMU/bridge.c" -o "$ROOT/.build/bridge-single.o"
$CLANG --target=wasm32 -O3 -flto -nostdlib "$ROOT/.build/Z80-single.o" "$ROOT/.build/bridge-single.o" \
  -Wl,--no-entry -Wl,--export-memory -Wl,--export-all \
  -Wl,--initial-memory=67108864 -Wl,--max-memory=134217728 \
  -Wl,-z,stack-size=1048576 -o "$OUT/z80-single.wasm"

# Shared-memory build: each browser worker owns a disjoint set of room states.
$CLANG $COMMON -matomics -mbulk-memory -c "$EMU/Z80.c" -o "$ROOT/.build/Z80-shared.o"
$CLANG $COMMON -matomics -mbulk-memory -c "$EMU/bridge.c" -o "$ROOT/.build/bridge-shared.o"
$CLANG --target=wasm32 -O3 -flto -matomics -mbulk-memory -nostdlib "$ROOT/.build/Z80-shared.o" "$ROOT/.build/bridge-shared.o" \
  -Wl,--no-entry -Wl,--import-memory -Wl,--shared-memory -Wl,--export-all -Wl,--export=__stack_pointer \
  -Wl,--initial-memory=67108864 -Wl,--max-memory=134217728 \
  -Wl,-z,stack-size=8388608 -o "$OUT/z80-shared.wasm"

echo "Built z80-single.wasm and z80-shared.wasm"
