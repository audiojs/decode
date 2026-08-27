#!/bin/bash
set -e
cd "$(dirname "$0")"

LIB=lib/liba52
OUT=src/ac3.wasm.js

if [ ! -f "$LIB/include/a52.h" ]; then
  git submodule update --init --depth 1 -- "$LIB"
fi

# Single-file WASM uses no host I/O. Omitting Emscripten's Node loader keeps the module graph host-neutral.
emcc \
  $LIB/liba52/bit_allocate.c $LIB/liba52/bitstream.c $LIB/liba52/crc.c $LIB/liba52/downmix.c \
  $LIB/liba52/imdct.c $LIB/liba52/parse.c $LIB/liba52/cpu_accel.c $LIB/liba52/cpu_state.c \
  src/ac3_glue.c \
  -I src -I "$LIB/include" -I "$LIB/liba52" \
  -DHAVE_CONFIG_H \
  -Oz \
  -flto \
  -s WASM=1 \
  -s STANDALONE_WASM=0 \
  -s EXPORTED_FUNCTIONS='[
    "_audio_ac3_create","_audio_ac3_syncinfo","_audio_ac3_decode","_audio_ac3_output",
    "_audio_ac3_channels","_audio_ac3_flags","_audio_ac3_sample_rate","_audio_ac3_bit_rate",
    "_audio_ac3_destroy","_malloc","_free"
  ]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=2097152 \
  -s MAXIMUM_MEMORY=67108864 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createAc3 \
  -s ENVIRONMENT='web,worklet,shell' \
  -s TEXTDECODER=1 \
  -s FILESYSTEM=0 \
  -s ASSERTIONS=0 \
  -s MALLOC=emmalloc \
  -s SINGLE_FILE=1 \
  --no-entry \
  -o "$OUT"

VERSION=$(git -C "$LIB" describe --tags --always 2>/dev/null || echo unknown)
echo "Built: $(wc -c < "$OUT") bytes (liba52 $VERSION)"
