#!/bin/bash
# Build the `ape` WASM module from a slim FFmpeg libavcodec (LGPL-2.1-or-later, no GPL components:
# configured without --enable-gpl). FFmpeg source is the shared submodule ../../lib/ffmpeg
# (decode repo root, release/7.1) — both decode-ape and decode-eac3 build from it, unvendored.
set -e
cd "$(dirname "$0")"

FFMPEG=../../lib/ffmpeg
BUILD=_build/ape
OUT=src/ape.wasm.js

if [ ! -f "$FFMPEG/configure" ]; then
	echo "lib/ffmpeg submodule not initialized — run from the decode repo root:" >&2
	echo "  git submodule update --init --depth 1 -- lib/ffmpeg" >&2
	exit 1
fi

mkdir -p "$BUILD"
if [ ! -f "$BUILD/libavcodec/libavcodec.a" ]; then
	(cd "$BUILD" && emconfigure ../../../../lib/ffmpeg/configure \
		--cc=emcc --ar=emar --ranlib=emranlib --nm=emnm \
		--enable-cross-compile --target-os=none --arch=x86_32 \
		--disable-everything --disable-all \
		--disable-programs --disable-doc --disable-network \
		--disable-asm --disable-x86asm --disable-inline-asm \
		--disable-runtime-cpudetect --disable-debug --disable-stripping \
		--enable-avcodec --enable-avutil \
		--disable-avformat --disable-swresample --disable-swscale --disable-avfilter --disable-avdevice --disable-postproc \
		--disable-pthreads --disable-w32threads --disable-os2threads \
		--disable-autodetect \
		--enable-small \
		--extra-cflags="-Oz" \
		--enable-decoder=ape)
	(cd "$BUILD" && emmake make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" libavcodec/libavcodec.a libavutil/libavutil.a)
fi

emcc \
	src/ape_glue.c \
	"$BUILD/libavcodec/libavcodec.a" "$BUILD/libavutil/libavutil.a" \
	-I "$BUILD" -I "$FFMPEG" \
	-Oz \
	-flto \
	-s WASM=1 \
	-s STANDALONE_WASM=0 \
	-s EXPORTED_FUNCTIONS='[
    "_audio_ape_create","_audio_ape_decode","_audio_ape_output",
    "_audio_ape_channels","_audio_ape_destroy","_malloc","_free"
  ]' \
	-s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32"]' \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s INITIAL_MEMORY=16777216 \
	-s MAXIMUM_MEMORY=536870912 \
	-s MODULARIZE=1 \
	-s EXPORT_ES6=1 \
	-s EXPORT_NAME=createApe \
	-s ENVIRONMENT='web,worklet,shell' \
	-s TEXTDECODER=1 \
	-s FILESYSTEM=0 \
	-s ASSERTIONS=0 \
	-s MALLOC=emmalloc \
	-s SINGLE_FILE=1 \
	--no-entry \
	-o "$OUT"

VERSION=$(git -C "$FFMPEG" describe --tags --always 2>/dev/null || echo unknown)
echo "Built: $(wc -c < "$OUT") bytes (FFmpeg $VERSION, ape decoder, LGPL-2.1-or-later)"
