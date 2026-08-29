/* E-AC-3 (Dolby Digital Plus) decoder — glue over FFmpeg's libavcodec `eac3` decoder
 * (LGPL-2.1-or-later). The eac3 decoder also parses plain AC-3 frames (bitstream_id <= 10,
 * see libavcodec/ac3dec.c parse_frame_header()) so this glue decodes both.
 * Public API only: avcodec_find_decoder / avcodec_alloc_context3 / avcodec_open2 /
 * avcodec_send_packet / avcodec_receive_frame. Sync-frame framing (syncword 0x0B77, frmsiz) is
 * found in JS — see decode-eac3.js — one packet per complete frame.
 * drc_scale is forced to 0 so dynamic range compression is not applied, matching
 * @audio/decode-ac3 (liba52, no dialnorm/DRC) — see that package's README.
 */
#include <stdlib.h>
#include <string.h>
#include <libavcodec/avcodec.h>
#include <libavcodec/ac3_parser.h>
#include <libavutil/opt.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

#define MAX_CH 16          /* EAC3_MAX_CHANNELS, libavcodec/ac3defs.h */
#define MAX_SAMPLES 1536   /* AC3_MAX_BLOCKS(6) * AC3_BLOCK_SIZE(256), one sync frame */

typedef struct {
	AVCodecContext *ctx;
	AVPacket *pkt;
	AVFrame *frame;
	float *out;   /* planar, MAX_CH * MAX_SAMPLES floats */
	int channels;
	int sample_rate;
} AudioEac3;

EXPORT void audio_eac3_destroy(AudioEac3 *d);

EXPORT AudioEac3 *audio_eac3_create(void) {
	av_log_set_level(AV_LOG_QUIET); /* corrupt/garbage input is an expected, silently-handled case here */
	const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_EAC3);
	if (!codec) return NULL;
	AudioEac3 *d = calloc(1, sizeof(*d));
	if (!d) return NULL;
	d->ctx = avcodec_alloc_context3(codec);
	if (!d->ctx) { free(d); return NULL; }
	av_opt_set(d->ctx->priv_data, "drc_scale", "0", 0);
	if (avcodec_open2(d->ctx, codec, NULL) < 0) { avcodec_free_context(&d->ctx); free(d); return NULL; }
	d->pkt = av_packet_alloc();
	d->frame = av_frame_alloc();
	d->out = malloc(sizeof(float) * MAX_CH * MAX_SAMPLES);
	if (!d->pkt || !d->frame || !d->out) { audio_eac3_destroy(d); return NULL; }
	return d;
}

/* Decode one complete (E-)AC-3 sync frame. `data`/`size` is exactly the frame's bytes
 * (syncword through frmsiz), one call per frame — see decode-eac3.js's sync-frame walker.
 * Returns samples decoded per channel (up to 1536), or a negative libav error code. Channels
 * and sample rate come out in WAV order already — ffmpeg's ac3 decoder builds a native
 * (bitmask) AVChannelLayout, whose channel order is ascending AV_CH_* bit order, i.e. WAV order. */
EXPORT int audio_eac3_decode(AudioEac3 *d, uint8_t *data, int size) {
	av_packet_unref(d->pkt);
	if (av_new_packet(d->pkt, size) < 0) return AVERROR(ENOMEM);
	memcpy(d->pkt->data, data, size);

	int ret = avcodec_send_packet(d->ctx, d->pkt);
	if (ret < 0) return ret;

	int filled = 0;
	for (;;) {
		int r = avcodec_receive_frame(d->ctx, d->frame);
		if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) break;
		if (r < 0) { if (filled) break; return r; }
		int ch = d->ctx->ch_layout.nb_channels, n = d->frame->nb_samples;
		if (ch > MAX_CH || filled + n > MAX_SAMPLES) { av_frame_unref(d->frame); break; } /* defensive: spec bounds this already */
		d->channels = ch;
		d->sample_rate = d->ctx->sample_rate;
		for (int c = 0; c < ch; c++)
			memcpy(d->out + (size_t)c * MAX_SAMPLES + filled, d->frame->data[c], n * sizeof(float));
		filled += n;
		av_frame_unref(d->frame);
	}
	return filled;
}

/* Parse a sync frame header (AC-3 or E-AC-3, ffmpeg's av_ac3_parse_header handles both — see
 * libavcodec/ac3_parser.c) and return its total byte length, 0 if the header isn't valid/complete
 * yet. Used by decode-eac3.js to cut complete frames out of the byte stream before decoding. */
EXPORT int audio_eac3_syncinfo(uint8_t *buf, int size) {
	uint8_t bitstream_id; uint16_t frame_size;
	if (av_ac3_parse_header(buf, (size_t)size, &bitstream_id, &frame_size) < 0) return 0;
	return frame_size;
}

EXPORT float *audio_eac3_output(AudioEac3 *d) { return d ? d->out : NULL; }
EXPORT int audio_eac3_channels(AudioEac3 *d) { return d ? d->channels : 0; }
EXPORT int audio_eac3_sample_rate(AudioEac3 *d) { return d ? d->sample_rate : 0; }

EXPORT void audio_eac3_destroy(AudioEac3 *d) {
	if (!d) return;
	if (d->frame) av_frame_free(&d->frame);
	if (d->pkt) av_packet_free(&d->pkt);
	if (d->ctx) avcodec_free_context(&d->ctx);
	free(d->out);
	free(d);
}
