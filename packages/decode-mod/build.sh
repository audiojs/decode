#!/bin/bash
set -e
cd "$(dirname "$0")"

LIB=lib/openmpt
ARCHIVE=$LIB/bin/libopenmpt.a
OUT=src/mod.wasm.js

if [ ! -f "$LIB/libopenmpt/libopenmpt.h" ]; then
  git submodule update --init --depth 1 -- "$LIB"
fi

# Stage 1: libopenmpt itself, via the project's own emscripten config (build/make/config-emscripten.mk).
# Static lib only — no shared lib, examples, CLI or test suite. NO_ZLIB/NO_MPG123/NO_OGG/NO_VORBIS/
# NO_VORBISFILE are already the emscripten config's defaults (ALLOW_LGPL unset); NO_MINIZ/NO_MINIMP3/
# NO_STBVORBIS drop the bundled MO3-sample-decompression fallbacks too — MO3 needs unmo3 or one of
# these fallbacks, none of which we carry, so MO3 files fail to load (unsupported, not decoded wrong).
if [ ! -f "$ARCHIVE" ]; then
  make -C "$LIB" CONFIG=emscripten \
    DYNLINK=0 SHARED_LIB=0 STATIC_LIB=1 EXAMPLES=0 OPENMPT123=0 TEST=0 \
    NO_MINIZ=1 NO_MINIMP3=1 NO_STBVORBIS=1 \
    -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" \
    bin/libopenmpt.a
fi

# Stage 2: our thin glue (src/mod_glue.c) + the static lib, into a single-file ES6 module.
emcc -c src/mod_glue.c -I "$LIB" -Oz -flto -s DISABLE_EXCEPTION_CATCHING=0 -o src/mod_glue.o

em++ \
  src/mod_glue.o "$ARCHIVE" \
  -Oz \
  -flto \
  -s DISABLE_EXCEPTION_CATCHING=0 \
  -s WASM=1 \
  -s STANDALONE_WASM=0 \
  -s EXPORTED_FUNCTIONS='[
    "_audio_mod_create","_audio_mod_last_error","_audio_mod_destroy",
    "_audio_mod_set_repeat_count","_audio_mod_get_duration_seconds","_audio_mod_set_render_param",
    "_audio_mod_get_num_channels","_audio_mod_get_num_instruments","_audio_mod_get_num_samples",
    "_audio_mod_get_num_patterns","_audio_mod_get_num_orders",
    "_audio_mod_read_mono","_audio_mod_read_stereo","_audio_mod_read_quad",
    "_audio_mod_get_metadata","_audio_mod_free_string",
    "_malloc","_free"
  ]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=33554432 \
  -s MAXIMUM_MEMORY=1073741824 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createMod \
  -s ENVIRONMENT='web,worklet,shell' \
  -s TEXTDECODER=1 \
  -s FILESYSTEM=0 \
  -s ASSERTIONS=0 \
  -s MALLOC=emmalloc \
  -s SINGLE_FILE=1 \
  --no-entry \
  -o "$OUT"

rm -f src/mod_glue.o

VERSION=$(git -C "$LIB" describe --tags --always 2>/dev/null || echo unknown)
echo "Built: $(wc -c < "$OUT") bytes (libopenmpt $VERSION)"
