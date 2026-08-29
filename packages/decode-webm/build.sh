#!/bin/bash
set -e

cp ../decode-opus/src/opus.wasm.js src/opus.wasm.js

npx esbuild src/decode-webm.src.js \
  --bundle \
  --format=esm \
  --outfile=decode-webm.js \
  --platform=node \
  --minify \
  --external:./src/opus.wasm.js \
  --external:@audio/decode-aac \
  --external:@audio/decode-mp3 \
  --external:@audio/decode-flac \
  --external:@audio/decode-ac3 \
  --external:@audio/decode-dts \
  --external:@audio/decode-eac3
