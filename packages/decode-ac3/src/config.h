/* minimal config for the Emscripten build: float samples, no SIMD, no memalign */
#define HAVE_INTTYPES_H 1
#define HAVE_STDINT_H 1
#define HAVE_STRING_H 1
#define HAVE_MEMALIGN 0
