#!/bin/bash
set -e
cd "$(dirname "$0")"

LIB=lib/opus
BUILD=.build/opus
OUT=src/opus.wasm.js
SOURCE_MAP="-ffile-prefix-map=$(pwd)=."

if [ ! -f "$LIB/CMakeLists.txt" ]; then
  git submodule update --init --depth 1 -- "$LIB"
fi

emcmake cmake -S "$LIB" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="-flto $SOURCE_MAP" \
  -DCMAKE_C_FLAGS_RELEASE="-Oz -DNDEBUG" \
  -DOPUS_BUILD_PROGRAMS=OFF \
  -DOPUS_BUILD_TESTING=OFF \
  -DOPUS_INSTALL_PKG_CONFIG_MODULE=OFF \
  -DOPUS_INSTALL_CMAKE_CONFIG_MODULE=OFF \
  -DOPUS_DISABLE_INTRINSICS=ON \
  -DOPUS_FLOAT_APPROX=ON \
  -DOPUS_DRED=OFF \
  -DOPUS_OSCE=OFF
cmake --build "$BUILD" --target opus -j4

# Single-file WASM uses no host I/O. Omitting Emscripten's Node loader keeps the module graph host-neutral.
emcc \
  src/opus_glue.c "$BUILD/libopus.a" \
  -I "$LIB/include" \
  -Oz \
  -flto \
  -s WASM=1 \
  -s STANDALONE_WASM=0 \
  -s EXPORTED_FUNCTIONS='[
    "_audio_opus_create","_audio_opus_decode","_audio_opus_output",
    "_audio_opus_last_error","_audio_opus_destroy","_malloc","_free"
  ]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=4194304 \
  -s MAXIMUM_MEMORY=67108864 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createOpus \
  -s ENVIRONMENT='web,worklet,shell' \
  -s TEXTDECODER=1 \
  -s FILESYSTEM=0 \
  -s ASSERTIONS=0 \
  -s MALLOC=emmalloc \
  -s SINGLE_FILE=1 \
  --no-entry \
  -o "$OUT"

npx esbuild src/decode-opus.src.js \
  --bundle \
  --format=esm \
  --outfile=src/decode-opus.js \
  --platform=node \
  --minify \
  --external:../core.js

VERSION=$(git -C "$LIB" describe --tags --always 2>/dev/null || echo unknown)
echo "Built: $(wc -c < "$OUT") bytes (libopus $VERSION)"
