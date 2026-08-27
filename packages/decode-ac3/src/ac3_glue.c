#include <stdlib.h>
#include <string.h>
#include <inttypes.h>
#include <a52.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

#define BLOCKS 6
#define BLOCK 256
#define MAX_CH 6

typedef struct {
	a52_state_t *state;
	float *out;          /* planar, MAX_CH * BLOCKS * BLOCK */
	int flags;           /* stream flags from the last syncinfo */
	int out_flags;       /* output layout of the last decoded frame */
	int sample_rate;
	int bit_rate;
	int channels;
} AudioAc3;

/* channel count per A52 layout code, LFE excluded */
static const int layout_channels[] = { 2, 1, 2, 3, 3, 4, 4, 5, 1, 1, 2 };

static int channels_of(int flags) {
	int mode = flags & A52_CHANNEL_MASK;
	int n = mode <= A52_DOLBY ? layout_channels[mode] : 2;
	return n + ((flags & A52_LFE) ? 1 : 0);
}

EXPORT AudioAc3 *audio_ac3_create(void) {
	AudioAc3 *d = calloc(1, sizeof(*d));
	if (!d) return NULL;
	d->state = a52_init();
	d->out = malloc(sizeof(float) * MAX_CH * BLOCKS * BLOCK);
	if (!d->state || !d->out) {
		if (d->state) a52_free(d->state);
		free(d->out);
		free(d);
		return NULL;
	}
	return d;
}

/* Parse a frame header (7 bytes). Returns the frame length in bytes, 0 if no valid sync. */
EXPORT int audio_ac3_syncinfo(AudioAc3 *d, uint8_t *buf) {
	int flags, sample_rate, bit_rate;
	int len = a52_syncinfo(buf, &flags, &sample_rate, &bit_rate);
	if (len) {
		d->flags = flags;
		d->sample_rate = sample_rate;
		d->bit_rate = bit_rate;
	}
	return len;
}

/* Decode one complete frame in the stream's own layout. Returns samples per channel (1536) or a negative error. */
EXPORT int audio_ac3_decode(AudioAc3 *d, uint8_t *buf) {
	int flags = d->flags & (A52_CHANNEL_MASK | A52_LFE);
	sample_t level = 1;
	if (a52_frame(d->state, buf, &flags, &level, 0)) return -1;
	int nch = channels_of(flags);
	d->out_flags = flags;
	d->channels = nch;
	for (int b = 0; b < BLOCKS; b++) {
		if (a52_block(d->state)) return -2;
		sample_t *s = a52_samples(d->state);
		for (int c = 0; c < nch; c++)
			memcpy(d->out + c * BLOCKS * BLOCK + b * BLOCK, s + c * BLOCK, BLOCK * sizeof(float));
	}
	return BLOCKS * BLOCK;
}

EXPORT float *audio_ac3_output(AudioAc3 *d) { return d ? d->out : NULL; }
EXPORT int audio_ac3_channels(AudioAc3 *d) { return d ? d->channels : 0; }
EXPORT int audio_ac3_flags(AudioAc3 *d) { return d ? d->out_flags : 0; }
EXPORT int audio_ac3_sample_rate(AudioAc3 *d) { return d ? d->sample_rate : 0; }
EXPORT int audio_ac3_bit_rate(AudioAc3 *d) { return d ? d->bit_rate : 0; }

EXPORT void audio_ac3_destroy(AudioAc3 *d) {
	if (!d) return;
	a52_free(d->state);
	free(d->out);
	free(d);
}
