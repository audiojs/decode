/* Thin C glue over libopenmpt's public C API (lib/openmpt/libopenmpt/libopenmpt.h).
 * Keeps the exported surface small and free of function-pointer arguments (the
 * logfunc/errfunc callbacks stay inside this translation unit) so the JS side
 * only ever passes plain numbers and pointers across the WASM boundary. */
#include <stdlib.h>
#include <string.h>
#include <libopenmpt/libopenmpt.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

static char last_error[256];

/* Both callbacks discard output — errors are read back explicitly via
 * audio_mod_last_error() / openmpt_module_error_get_last_message(). */
static void mod_logfunc(const char *message, void *user) { (void)message; (void)user; }
static int mod_errfunc(int error, void *user) { (void)error; (void)user; return OPENMPT_ERROR_FUNC_RESULT_STORE; }

static void set_last_error(int err, const char *err_str) {
	const char *s = err_str;
	if (!s) s = openmpt_error_string(err);
	if (s) { strncpy(last_error, s, sizeof(last_error) - 1); last_error[sizeof(last_error) - 1] = 0; }
	else last_error[0] = 0;
}

/* Parse a complete module from memory. Returns NULL on failure (garbage input,
 * unrecognized format, truncated file) — see audio_mod_last_error(). */
EXPORT openmpt_module *audio_mod_create(const void *data, size_t size) {
	int err = OPENMPT_ERROR_OK;
	const char *err_str = NULL;
	openmpt_module *mod = openmpt_module_create_from_memory2(data, size, mod_logfunc, NULL, mod_errfunc, NULL, &err, &err_str, NULL);
	if (!mod) set_last_error(err, err_str);
	if (err_str) openmpt_free_string(err_str);
	return mod;
}

EXPORT const char *audio_mod_last_error(void) { return last_error; }

EXPORT void audio_mod_destroy(openmpt_module *mod) { if (mod) openmpt_module_destroy(mod); }

EXPORT void audio_mod_set_repeat_count(openmpt_module *mod, int32_t count) { openmpt_module_set_repeat_count(mod, count); }
EXPORT double audio_mod_get_duration_seconds(openmpt_module *mod) { return openmpt_module_get_duration_seconds(mod); }

/* param: OPENMPT_MODULE_RENDER_{MASTERGAIN_MILLIBEL=1,STEREOSEPARATION_PERCENT=2,INTERPOLATIONFILTER_LENGTH=3,VOLUMERAMPING_STRENGTH=4} */
EXPORT int audio_mod_set_render_param(openmpt_module *mod, int param, int32_t value) { return openmpt_module_set_render_param(mod, param, value); }

EXPORT int32_t audio_mod_get_num_channels(openmpt_module *mod) { return openmpt_module_get_num_channels(mod); }
EXPORT int32_t audio_mod_get_num_instruments(openmpt_module *mod) { return openmpt_module_get_num_instruments(mod); }
EXPORT int32_t audio_mod_get_num_samples(openmpt_module *mod) { return openmpt_module_get_num_samples(mod); }
EXPORT int32_t audio_mod_get_num_patterns(openmpt_module *mod) { return openmpt_module_get_num_patterns(mod); }
EXPORT int32_t audio_mod_get_num_orders(openmpt_module *mod) { return openmpt_module_get_num_orders(mod); }

/* Planar float render, [-1,1] nominal (may overshoot, not clipped). Returns frames
 * actually written; 0 means the song ended (repeat count exhausted). */
EXPORT size_t audio_mod_read_mono(openmpt_module *mod, int32_t sr, size_t count, float *out) {
	return openmpt_module_read_float_mono(mod, sr, count, out);
}
EXPORT size_t audio_mod_read_stereo(openmpt_module *mod, int32_t sr, size_t count, float *l, float *r) {
	return openmpt_module_read_float_stereo(mod, sr, count, l, r);
}
EXPORT size_t audio_mod_read_quad(openmpt_module *mod, int32_t sr, size_t count, float *l, float *r, float *rl, float *rr) {
	return openmpt_module_read_float_quad(mod, sr, count, l, r, rl, rr);
}

/* key: "title" | "artist" | "type" | "type_long" | "tracker" | "message" | ... (see
 * libopenmpt.h openmpt_module_get_metadata for the full key list). Dynamically
 * allocated — free with audio_mod_free_string(). */
EXPORT const char *audio_mod_get_metadata(openmpt_module *mod, const char *key) { return openmpt_module_get_metadata(mod, key); }
EXPORT void audio_mod_free_string(const char *s) { openmpt_free_string(s); }
