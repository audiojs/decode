#!/bin/bash
set -e
cd "$(dirname "$0")"

LIB=lib/libmpc
OUT=src/mpc.wasm.js

if [ ! -f "$LIB/include/mpc/mpcdec.h" ]; then
  git submodule update --init --depth 1 -- "$LIB"
fi

# MPC_FIXED_POINT is intentionally left undefined -- MPC_SAMPLE_FORMAT resolves to float
# (mpc_types.h), so mpc_demux_decode() hands back native [-1, 1] float samples directly,
# no fixed-point requantization step needed on the JS side.
emcc \
  $LIB/libmpcdec/huffman.c $LIB/libmpcdec/mpc_decoder.c $LIB/libmpcdec/mpc_demux.c \
  $LIB/libmpcdec/mpc_bits_reader.c $LIB/libmpcdec/requant.c $LIB/libmpcdec/streaminfo.c \
  $LIB/libmpcdec/synth_filter.c $LIB/common/crc32.c \
  src/mpc_glue.c \
  -I "$LIB/include" -I "$LIB/libmpcdec" \
  -Oz \
  -flto \
  -s WASM=1 \
  -s STANDALONE_WASM=0 \
  -s EXPORTED_FUNCTIONS='[
    "_audio_mpc_create","_audio_mpc_feed","_audio_mpc_init",
    "_audio_mpc_channels","_audio_mpc_sample_rate","_audio_mpc_stream_version",
    "_audio_mpc_avail","_audio_mpc_decode","_audio_mpc_output","_audio_mpc_destroy",
    "_malloc","_free"
  ]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=2097152 \
  -s MAXIMUM_MEMORY=268435456 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createMpc \
  -s ENVIRONMENT='web,worklet,shell' \
  -s TEXTDECODER=1 \
  -s FILESYSTEM=0 \
  -s ASSERTIONS=0 \
  -s MALLOC=emmalloc \
  -s SINGLE_FILE=1 \
  --no-entry \
  -o "$OUT"

VERSION=$(git -C "$LIB" describe --tags --always 2>/dev/null || echo unknown)
echo "Built: $(wc -c < "$OUT") bytes (libmpcdec $VERSION)"
