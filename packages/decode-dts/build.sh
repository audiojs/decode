#!/bin/bash
set -e
cd "$(dirname "$0")"

LIB=lib/libdca
OUT=src/dts.wasm.js

if [ ! -f "$LIB/include/dca.h" ]; then
  git submodule update --init --depth 1 -- "$LIB"
fi

# Single-file WASM uses no host I/O. Omitting Emscripten's Node loader keeps the module graph host-neutral.
emcc \
  $LIB/libdca/bitstream.c $LIB/libdca/downmix.c $LIB/libdca/parse.c \
  src/dts_glue.c \
  -I src -I "$LIB/include" -I "$LIB/libdca" \
  -DHAVE_CONFIG_H \
  -Oz \
  -flto \
  -s WASM=1 \
  -s STANDALONE_WASM=0 \
  -s EXPORTED_FUNCTIONS='[
    "_audio_dts_create","_audio_dts_syncinfo","_audio_dts_decode","_audio_dts_output",
    "_audio_dts_channels","_audio_dts_flags","_audio_dts_sample_rate","_audio_dts_bit_rate",
    "_audio_dts_destroy","_malloc","_free"
  ]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=2097152 \
  -s MAXIMUM_MEMORY=67108864 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createDts \
  -s ENVIRONMENT='web,worklet,shell' \
  -s TEXTDECODER=1 \
  -s FILESYSTEM=0 \
  -s ASSERTIONS=0 \
  -s MALLOC=emmalloc \
  -s SINGLE_FILE=1 \
  --no-entry \
  -o "$OUT"

VERSION=$(git -C "$LIB" describe --tags --always 2>/dev/null || echo unknown)
echo "Built: $(wc -c < "$OUT") bytes (libdca $VERSION)"
