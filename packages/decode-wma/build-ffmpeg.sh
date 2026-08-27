#!/bin/bash
# Build FFmpeg WMA decoder + glue -> wma.wasm.js
#
# Prerequisites:
#   1. Emscripten SDK (emsdk) activated
#   2. FFmpeg source: cd lib && git clone --depth 1 https://github.com/FFmpeg/FFmpeg.git ffmpeg
#
# The build extracts only the minimal FFmpeg components needed for WMA decoding:
#   - libavcodec: wmadec, wma, wma_common, mdct, fft, bitstream
#   - libavutil: mem, mathematics, log, channel_layout, samplefmt, etc.
set -e

# Find python 3.10+ for emscripten
if [ -z "$EMSDK_PYTHON" ]; then
  for py in python3.14 python3.13 python3.12 python3.11 python3.10 python3; do
    ver=$($py -c 'import sys;print(sys.version_info[1])' 2>/dev/null)
    if [ -n "$ver" ] && [ "$ver" -ge 10 ]; then
      export EMSDK_PYTHON=$(which $py)
      break
    fi
  done
fi

FFMPEG=lib/ffmpeg
OUT=src/wma.wasm.js

# Clone FFmpeg source if not present
if [ ! -d "$FFMPEG" ]; then
  echo "Fetching FFmpeg source..."
  mkdir -p lib
  git clone --depth 1 --single-branch https://github.com/FFmpeg/FFmpeg.git "$FFMPEG"
  echo "FFmpeg source fetched."
fi

# Step 1: Configure FFmpeg for WASM (minimal, WMA-only)
# This generates config.h and other needed headers
if [ ! -f "$FFMPEG/config.h" ]; then
  echo "Configuring FFmpeg for Emscripten..."
  cd $FFMPEG
  emconfigure ./configure \
    --cc=emcc \
    --cxx=em++ \
    --ar=emar \
    --ranlib=emranlib \
    --enable-cross-compile \
    --target-os=none \
    --arch=x86 \
    --disable-runtime-cpudetect \
    --disable-asm \
    --disable-inline-asm \
    --disable-programs \
    --disable-doc \
    --disable-debug \
    --disable-network \
    --disable-everything \
    --enable-decoder=wmav1 \
    --enable-decoder=wmav2 \
    --enable-decoder=wmapro \
    --enable-decoder=wmalossless \
    --disable-pthreads \
    --disable-avformat \
    --disable-avfilter \
    --disable-swresample \
    --disable-swscale \
    --disable-avdevice \
    --extra-cflags="-O3 -flto"
  cd ../..
fi

# Step 2: Build just libavutil and libavcodec
echo "Building FFmpeg libraries..."
emmake make -C $FFMPEG -j$(nproc 2>/dev/null || sysctl -n hw.ncpu) libavutil/libavutil.a libavcodec/libavcodec.a

# Step 3: Compile glue + link
echo "Compiling WASM module..."
emcc \
  src/wma_glue_ffmpeg.c \
  -I $FFMPEG \
  $FFMPEG/libavcodec/libavcodec.a \
  $FFMPEG/libavutil/libavutil.a \
  -O3 \
  -flto \
  -s WASM=1 \
  -s STANDALONE_WASM=0 \
  -s EXPORTED_FUNCTIONS='[
    "_wma_create","_wma_decode","_wma_close",
    "_wma_samples","_wma_channels","_wma_samplerate",
    "_wma_free_buf",
    "_malloc","_free"
  ]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32","getValue"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=4194304 \
  -s MAXIMUM_MEMORY=134217728 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createWMA \
  -s ENVIRONMENT='web,worklet,shell' \
  -s TEXTDECODER=1 \
  -s FILESYSTEM=0 \
  -s ASSERTIONS=0 \
  -s MALLOC=emmalloc \
  -s SINGLE_FILE=1 \
  --no-entry \
  -o "$OUT"

echo "Built: $(wc -c < "$OUT") bytes"
