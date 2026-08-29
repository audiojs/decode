#!/bin/bash
set -e
cd "$(dirname "$0")"

LIB=lib/wavpack
OUT=src/wavpack.wasm.js

if [ ! -f "$LIB/include/wavpack.h" ]; then
  git submodule update --init --depth 1 -- "$LIB"
fi

SRC="$LIB/src"

# Single-file WASM uses no host I/O. Omitting Emscripten's Node loader keeps the module graph
# host-neutral. Threading and legacy (<4.0) decode are left out: no pthreads in a single-file
# module, and MIN_STREAM_VERS already excludes pre-4.0 streams. DSD is kept in (decoded as PCM
# via OPEN_DSD_AS_PCM).
emcc \
  $SRC/common_utils.c $SRC/decorr_utils.c $SRC/entropy_utils.c $SRC/extra1.c $SRC/extra2.c \
  $SRC/open_utils.c $SRC/open_filename.c $SRC/open_legacy.c $SRC/open_raw.c \
  $SRC/pack.c $SRC/pack_dns.c $SRC/pack_dsd.c $SRC/pack_floats.c $SRC/pack_utils.c \
  $SRC/read_words.c $SRC/tags.c $SRC/tag_utils.c \
  $SRC/unpack.c $SRC/unpack_dsd.c $SRC/unpack_floats.c $SRC/unpack_seek.c $SRC/unpack_utils.c \
  $SRC/write_words.c \
  src/wavpack_glue.c \
  -I src -I "$LIB/include" -I "$SRC" \
  -DENABLE_DSD -DHAVE___BUILTIN_CLZ \
  -Oz \
  -flto \
  -s WASM=1 \
  -s STANDALONE_WASM=0 \
  -s EXPORTED_FUNCTIONS='[
    "_wv_create","_wv_reserve","_wv_feed","_wv_output",
    "_wv_channels","_wv_rate","_wv_bits","_wv_is_float","_wv_is_lossless",
    "_wv_error","_wv_destroy","_malloc","_free"
  ]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAP32"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=4194304 \
  -s MAXIMUM_MEMORY=134217728 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createWavpack \
  -s ENVIRONMENT='web,worklet,shell' \
  -s FILESYSTEM=0 \
  -s ASSERTIONS=0 \
  -s MALLOC=emmalloc \
  -s SINGLE_FILE=1 \
  --no-entry \
  -o "$OUT"

VERSION=$(git -C "$LIB" describe --tags --always 2>/dev/null || echo unknown)
echo "Built: $(wc -c < "$OUT") bytes (WavPack $VERSION)"
