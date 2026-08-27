#!/bin/bash
# Build FAAD2 + glue -> aac.wasm.js
set -e

# find python 3.10+ for emscripten
if [ -z "$EMSDK_PYTHON" ]; then
  for py in python3.14 python3.13 python3.12 python3.11 python3.10 python3; do
    ver=$($py -c 'import sys;print(sys.version_info[1])' 2>/dev/null)
    if [ -n "$ver" ] && [ "$ver" -ge 10 ]; then
      export EMSDK_PYTHON=$(which $py)
      break
    fi
  done
fi

FAAD=lib/faad2
OUT=src/aac.wasm.js

# read FAAD2 version from source of truth
FAAD_VERSION=$($EMSDK_PYTHON -c "import json; print(json.load(open('$FAAD/properties.json'))['PACKAGE_VERSION'])" 2>/dev/null \
  || python3 -c "import json; print(json.load(open('$FAAD/properties.json'))['PACKAGE_VERSION'])" 2>/dev/null \
  || echo "unknown")

# collect all FAAD2 libfaad C sources
SRCS=$(find $FAAD/libfaad -name '*.c' | sort)

# Single-file WASM uses no host I/O. Omitting Emscripten's Node loader keeps the module graph host-neutral.
emcc \
  $SRCS \
  src/aac_glue.c \
  -I $FAAD/include \
  -I $FAAD/libfaad \
  -DHAVE_INTTYPES_H=1 \
  -DHAVE_MEMCPY=1 \
  -DHAVE_STRING_H=1 \
  -DHAVE_STRINGS_H=1 \
  -DHAVE_SYS_STAT_H=1 \
  -DHAVE_SYS_TYPES_H=1 \
  -DHAVE_LRINTF=1 \
  -DPACKAGE_VERSION=\"$FAAD_VERSION\" \
  -DAPPLY_DRC \
  -DSBR_LOW_POWER \
  -O3 \
  -flto \
  -s WASM=1 \
  -s STANDALONE_WASM=0 \
  -s EXPORTED_FUNCTIONS='[
    "_aac_create","_aac_init","_aac_init2","_aac_decode","_aac_close",
    "_aac_samples","_aac_channels","_aac_samplerate","_aac_consumed",
    "_aac_error","_aac_error_msg",
    "_aac_free_buf","_aac_sr_ptr","_aac_ch_ptr",
    "_malloc","_free"
  ]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32","getValue"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=2097152 \
  -s MAXIMUM_MEMORY=67108864 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createAAC \
  -s ENVIRONMENT='web,worklet,shell' \
  -s TEXTDECODER=1 \
  -s FILESYSTEM=0 \
  -s ASSERTIONS=0 \
  -s MALLOC=emmalloc \
  -s SINGLE_FILE=1 \
  --no-entry \
  -o "$OUT"

echo "Built: $(wc -c < "$OUT") bytes (FAAD2 $FAAD_VERSION)"
