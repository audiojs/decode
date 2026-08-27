#!/bin/bash
# Build opencore-amr + glue -> amr.wasm.js
set -e

# Download opencore-amr source if not present
LIB=lib/opencore-amr
if [ ! -d "$LIB" ]; then
  echo "Fetching opencore-amr 0.1.6..."
  mkdir -p lib
  curl -L "https://sourceforge.net/projects/opencore-amr/files/opencore-amr/opencore-amr-0.1.6.tar.gz/download" -o lib/opencore-amr.tar.gz
  tar xf lib/opencore-amr.tar.gz -C lib/
  mv lib/opencore-amr-0.1.6 "$LIB"
  rm lib/opencore-amr.tar.gz
  # Remove encoder sources (not needed for decode-only WASM)
  rm -rf "$LIB/opencore/codecs_v2/audio/gsm_amr/amr_nb/enc"
  rm -f "$LIB/amrnb/interf_enc.h"
  rm -rf "$LIB/test"
  # Remove autotools cruft
  rm -f "$LIB"/{configure,configure.ac,ltmain.sh,install-sh,missing,depcomp,compile,config.guess,config.sub,aclocal.m4,Makefile.am,Makefile.in}
  rm -rf "$LIB"/{autom4te.cache,m4}
  echo "opencore-amr fetched and stripped."
fi

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

LIB=lib/opencore-amr
OUT=src/amr.wasm.js

# read opencore-amr version from source of truth
AMR_VERSION=$($EMSDK_PYTHON -c "import json; print(json.load(open('$LIB/properties.json'))['PACKAGE_VERSION'])" 2>/dev/null \
  || python3 -c "import json; print(json.load(open('$LIB/properties.json'))['PACKAGE_VERSION'])" 2>/dev/null \
  || echo "unknown")

OC=$LIB/opencore/codecs_v2/audio/gsm_amr
NB_DEC=$OC/amr_nb/dec/src
NB_COM=$OC/amr_nb/common/src
WB_DEC=$OC/amr_wb/dec/src

# Source lists from Makefile.am (excludes PV framework wrappers)

NB_DEC_SRCS="
  $NB_DEC/agc.cpp
  $NB_DEC/amrdecode.cpp
  $NB_DEC/a_refl.cpp
  $NB_DEC/b_cn_cod.cpp
  $NB_DEC/bgnscd.cpp
  $NB_DEC/c_g_aver.cpp
  $NB_DEC/d1035pf.cpp
  $NB_DEC/d2_11pf.cpp
  $NB_DEC/d2_9pf.cpp
  $NB_DEC/d3_14pf.cpp
  $NB_DEC/d4_17pf.cpp
  $NB_DEC/d8_31pf.cpp
  $NB_DEC/dec_amr.cpp
  $NB_DEC/dec_gain.cpp
  $NB_DEC/dec_input_format_tab.cpp
  $NB_DEC/dec_lag3.cpp
  $NB_DEC/dec_lag6.cpp
  $NB_DEC/d_gain_c.cpp
  $NB_DEC/d_gain_p.cpp
  $NB_DEC/d_plsf_3.cpp
  $NB_DEC/d_plsf_5.cpp
  $NB_DEC/d_plsf.cpp
  $NB_DEC/dtx_dec.cpp
  $NB_DEC/ec_gains.cpp
  $NB_DEC/ex_ctrl.cpp
  $NB_DEC/if2_to_ets.cpp
  $NB_DEC/int_lsf.cpp
  $NB_DEC/lsp_avg.cpp
  $NB_DEC/ph_disp.cpp
  $NB_DEC/post_pro.cpp
  $NB_DEC/preemph.cpp
  $NB_DEC/pstfilt.cpp
  $NB_DEC/qgain475_tab.cpp
  $NB_DEC/sp_dec.cpp
  $NB_DEC/wmf_to_ets.cpp
"

NB_COMMON_SRCS="
  $NB_COM/add.cpp
  $NB_COM/az_lsp.cpp
  $NB_COM/bitno_tab.cpp
  $NB_COM/bitreorder_tab.cpp
  $NB_COM/c2_9pf_tab.cpp
  $NB_COM/div_s.cpp
  $NB_COM/extract_h.cpp
  $NB_COM/extract_l.cpp
  $NB_COM/gains_tbl.cpp
  $NB_COM/gc_pred.cpp
  $NB_COM/get_const_tbls.cpp
  $NB_COM/gmed_n.cpp
  $NB_COM/gray_tbl.cpp
  $NB_COM/grid_tbl.cpp
  $NB_COM/int_lpc.cpp
  $NB_COM/inv_sqrt.cpp
  $NB_COM/inv_sqrt_tbl.cpp
  $NB_COM/l_deposit_h.cpp
  $NB_COM/l_deposit_l.cpp
  $NB_COM/log2.cpp
  $NB_COM/log2_norm.cpp
  $NB_COM/log2_tbl.cpp
  $NB_COM/lsfwt.cpp
  $NB_COM/l_shr_r.cpp
  $NB_COM/lsp_az.cpp
  $NB_COM/lsp.cpp
  $NB_COM/lsp_lsf.cpp
  $NB_COM/lsp_lsf_tbl.cpp
  $NB_COM/lsp_tab.cpp
  $NB_COM/mult_r.cpp
  $NB_COM/negate.cpp
  $NB_COM/norm_l.cpp
  $NB_COM/norm_s.cpp
  $NB_COM/overflow_tbl.cpp
  $NB_COM/ph_disp_tab.cpp
  $NB_COM/pow2.cpp
  $NB_COM/pow2_tbl.cpp
  $NB_COM/pred_lt.cpp
  $NB_COM/q_plsf_3.cpp
  $NB_COM/q_plsf_3_tbl.cpp
  $NB_COM/q_plsf_5.cpp
  $NB_COM/q_plsf_5_tbl.cpp
  $NB_COM/q_plsf.cpp
  $NB_COM/qua_gain_tbl.cpp
  $NB_COM/reorder.cpp
  $NB_COM/residu.cpp
  $NB_COM/round.cpp
  $NB_COM/set_zero.cpp
  $NB_COM/shr.cpp
  $NB_COM/shr_r.cpp
  $NB_COM/sqrt_l.cpp
  $NB_COM/sqrt_l_tbl.cpp
  $NB_COM/sub.cpp
  $NB_COM/syn_filt.cpp
  $NB_COM/weight_a.cpp
  $NB_COM/window_tab.cpp
"

WB_DEC_SRCS="
  $WB_DEC/agc2_amr_wb.cpp
  $WB_DEC/band_pass_6k_7k.cpp
  $WB_DEC/dec_acelp_2p_in_64.cpp
  $WB_DEC/dec_acelp_4p_in_64.cpp
  $WB_DEC/dec_alg_codebook.cpp
  $WB_DEC/dec_gain2_amr_wb.cpp
  $WB_DEC/deemphasis_32.cpp
  $WB_DEC/dtx_decoder_amr_wb.cpp
  $WB_DEC/get_amr_wb_bits.cpp
  $WB_DEC/highpass_400hz_at_12k8.cpp
  $WB_DEC/highpass_50hz_at_12k8.cpp
  $WB_DEC/homing_amr_wb_dec.cpp
  $WB_DEC/interpolate_isp.cpp
  $WB_DEC/isf_extrapolation.cpp
  $WB_DEC/isp_az.cpp
  $WB_DEC/isp_isf.cpp
  $WB_DEC/lagconceal.cpp
  $WB_DEC/low_pass_filt_7k.cpp
  $WB_DEC/median5.cpp
  $WB_DEC/mime_io.cpp
  $WB_DEC/noise_gen_amrwb.cpp
  $WB_DEC/normalize_amr_wb.cpp
  $WB_DEC/oversamp_12k8_to_16k.cpp
  $WB_DEC/phase_dispersion.cpp
  $WB_DEC/pit_shrp.cpp
  $WB_DEC/pred_lt4.cpp
  $WB_DEC/preemph_amrwb_dec.cpp
  $WB_DEC/pvamrwbdecoder.cpp
  $WB_DEC/pvamrwb_math_op.cpp
  $WB_DEC/q_gain2_tab.cpp
  $WB_DEC/qisf_ns.cpp
  $WB_DEC/qisf_ns_tab.cpp
  $WB_DEC/qpisf_2s.cpp
  $WB_DEC/qpisf_2s_tab.cpp
  $WB_DEC/scale_signal.cpp
  $WB_DEC/synthesis_amr_wb.cpp
  $WB_DEC/voice_factor.cpp
  $WB_DEC/wb_syn_filt.cpp
  $WB_DEC/weight_amrwb_lpc.cpp
"

# include paths (from Makefile.am)
INCS="
  -I $LIB/oscl
  -I $LIB/amrnb
  -I $LIB/amrwb
  -I $OC/amr_nb/dec/src
  -I $OC/amr_nb/dec/include
  -I $OC/amr_nb/common/include
  -I $OC/amr_nb/common/src
  -I $OC/amr_nb/enc/src
  -I $OC/amr_wb/dec/src
  -I $OC/amr_wb/dec/include
  -I $OC/common/dec/include
"

# Single-file WASM uses no host I/O. Omitting Emscripten's Node loader keeps the module graph host-neutral.
emcc \
  $NB_DEC_SRCS \
  $NB_COMMON_SRCS \
  $WB_DEC_SRCS \
  $LIB/amrnb/wrapper.cpp \
  $LIB/amrwb/wrapper.cpp \
  src/amr_glue.c \
  $INCS \
  -DDISABLE_AMRNB_ENCODER \
  -Wno-register \
  -O3 \
  -flto \
  -s WASM=1 \
  -s STANDALONE_WASM=0 \
  -s EXPORTED_FUNCTIONS='[
    "_amr_nb_create","_amr_nb_decode","_amr_nb_output","_amr_nb_close",
    "_amr_wb_create","_amr_wb_decode","_amr_wb_output","_amr_wb_close",
    "_malloc","_free"
  ]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=1048576 \
  -s MAXIMUM_MEMORY=16777216 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createAMR \
  -s ENVIRONMENT='web,worklet,shell' \
  -s TEXTDECODER=1 \
  -s FILESYSTEM=0 \
  -s ASSERTIONS=0 \
  -s MALLOC=emmalloc \
  -s SINGLE_FILE=1 \
  --no-entry \
  -o "$OUT"

echo "Built: $(wc -c < "$OUT") bytes (opencore-amr $AMR_VERSION)"
