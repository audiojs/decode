#include <stdlib.h>
#include <string.h>
#include <inttypes.h>
#include <dca.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

#define MAX_BLOCKS 16
#define BLOCK 256
#define MAX_CH 7

typedef struct {
	dca_state_t *state;
	float *out;          /* planar, MAX_CH * MAX_BLOCKS * BLOCK */
	int flags;           /* stream flags from the last syncinfo */
	int out_flags;       /* output layout of the last decoded frame */
	int sample_rate;
	int bit_rate;
	int frame_length;    /* samples per channel per frame */
	int channels;
} AudioDts;

/* channel count per DCA layout code, LFE excluded */
static const int layout_channels[] = { 1, 2, 2, 2, 2, 3, 3, 4, 4, 5, 6 };

static int channels_of(int flags) {
	int mode = flags & DCA_CHANNEL_MASK;
	int n = mode <= DCA_4F2R ? layout_channels[mode] : 2;
	return n + ((flags & DCA_LFE) ? 1 : 0);
}

EXPORT AudioDts *audio_dts_create(void) {
	AudioDts *d = calloc(1, sizeof(*d));
	if (!d) return NULL;
	d->state = dca_init(0);
	d->out = malloc(sizeof(float) * MAX_CH * MAX_BLOCKS * BLOCK);
	if (!d->state || !d->out) {
		if (d->state) dca_free(d->state);
		free(d->out);
		free(d);
		return NULL;
	}
	return d;
}

/* Parse a core frame header (16 bytes suffice). Returns the frame length in bytes, 0 if no valid sync. */
EXPORT int audio_dts_syncinfo(AudioDts *d, uint8_t *buf) {
	int flags, sample_rate, bit_rate, frame_length;
	int len = dca_syncinfo(d->state, buf, &flags, &sample_rate, &bit_rate, &frame_length);
	if (len) {
		d->flags = flags;
		d->sample_rate = sample_rate;
		d->bit_rate = bit_rate;
		d->frame_length = frame_length;
	}
	return len;
}

/* Decode one complete core frame in the stream's own layout. Returns samples per channel or a negative error. */
EXPORT int audio_dts_decode(AudioDts *d, uint8_t *buf) {
	int flags = d->flags & (DCA_CHANNEL_MASK | DCA_LFE);
	level_t level = 1;
	if (dca_frame(d->state, buf, &flags, &level, 0)) return -1;
	int blocks = dca_blocks_num(d->state);
	if (blocks < 1 || blocks > MAX_BLOCKS) return -3;
	int nch = channels_of(flags);
	if (nch > MAX_CH) return -4;
	d->out_flags = flags;
	d->channels = nch;
	for (int b = 0; b < blocks; b++) {
		if (dca_block(d->state)) return -2;
		sample_t *s = dca_samples(d->state);
		for (int c = 0; c < nch; c++)
			memcpy(d->out + c * blocks * BLOCK + b * BLOCK, s + c * BLOCK, BLOCK * sizeof(float));
	}
	return blocks * BLOCK;
}

EXPORT float *audio_dts_output(AudioDts *d) { return d ? d->out : NULL; }
EXPORT int audio_dts_channels(AudioDts *d) { return d ? d->channels : 0; }
EXPORT int audio_dts_flags(AudioDts *d) { return d ? d->out_flags : 0; }
EXPORT int audio_dts_sample_rate(AudioDts *d) { return d ? d->sample_rate : 0; }
EXPORT int audio_dts_bit_rate(AudioDts *d) { return d ? d->bit_rate : 0; }

EXPORT void audio_dts_destroy(AudioDts *d) {
	if (!d) return;
	dca_free(d->state);
	free(d->out);
	free(d);
}
