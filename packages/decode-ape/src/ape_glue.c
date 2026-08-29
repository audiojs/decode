/* Monkey's Audio (APE) decoder — glue over FFmpeg's libavcodec `ape` decoder (LGPL-2.1-or-later).
 * Public API only: avcodec_find_decoder / avcodec_alloc_context3 / avcodec_open2 /
 * avcodec_send_packet / avcodec_receive_frame. Container framing (extradata, per-frame
 * packet layout) is computed in JS from the Monkey's Audio header — see decode-ape.js.
 */
#include <stdlib.h>
#include <string.h>
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

typedef struct {
	AVCodecContext *ctx;
	AVPacket *pkt;
	AVFrame *frame;
	float *out;     /* planar, channels * cap floats */
	int cap;        /* samples-per-channel capacity of out */
	int channels;
} AudioApe;

EXPORT void audio_ape_destroy(AudioApe *d);

/* Convert one decoded AVFrame's planar samples to float in [-1, 1], appended at `filled`. */
static void conv_planar(AVCodecContext *ctx, AVFrame *f, float *out, int stride, int filled) {
	int ch = ctx->ch_layout.nb_channels, n = f->nb_samples;
	for (int c = 0; c < ch; c++) {
		float *dst = out + (size_t)c * stride + filled;
		switch (ctx->sample_fmt) {
		case AV_SAMPLE_FMT_U8P: {
			uint8_t *s = (uint8_t *)f->data[c];
			for (int i = 0; i < n; i++) dst[i] = (s[i] - 128) / 128.0f;
			break;
		}
		case AV_SAMPLE_FMT_S16P: {
			int16_t *s = (int16_t *)f->data[c];
			for (int i = 0; i < n; i++) dst[i] = s[i] / 32768.0f;
			break;
		}
		case AV_SAMPLE_FMT_S32P: {
			int32_t *s = (int32_t *)f->data[c];
			for (int i = 0; i < n; i++) dst[i] = s[i] / 2147483648.0f;
			break;
		}
		default: break; /* ape decoder never emits another format */
		}
	}
}

/* channels: 1 or 2. bps: 8, 16 or 24 (ape decoder supports no other). extradata: 6 bytes
 * (fileversion u16le, compressiontype u16le, formatflags u16le) — the exact bytes libavformat's
 * ape demuxer stores, see libavformat/ape.c ape_read_header(). */
EXPORT AudioApe *audio_ape_create(int channels, int sample_rate, int bps, uint8_t *extradata) {
	av_log_set_level(AV_LOG_QUIET); /* corrupt/garbage input is an expected, silently-handled case here */
	const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_APE);
	if (!codec) return NULL;
	AudioApe *d = calloc(1, sizeof(*d));
	if (!d) return NULL;
	d->ctx = avcodec_alloc_context3(codec);
	if (!d->ctx) { free(d); return NULL; }
	av_channel_layout_default(&d->ctx->ch_layout, channels);
	d->ctx->sample_rate = sample_rate;
	d->ctx->bits_per_coded_sample = bps;
	d->ctx->extradata = av_mallocz(6 + AV_INPUT_BUFFER_PADDING_SIZE);
	if (!d->ctx->extradata) { avcodec_free_context(&d->ctx); free(d); return NULL; }
	memcpy(d->ctx->extradata, extradata, 6);
	d->ctx->extradata_size = 6;
	if (avcodec_open2(d->ctx, codec, NULL) < 0) { avcodec_free_context(&d->ctx); free(d); return NULL; }
	d->pkt = av_packet_alloc();
	d->frame = av_frame_alloc();
	if (!d->pkt || !d->frame) { audio_ape_destroy(d); return NULL; }
	d->channels = channels;
	return d;
}

/* Decode one Monkey's Audio container frame. `data` is the exact packet libavformat's ape demuxer
 * builds: [nblocks u32le][skip u32le][compressed bytes...] (see ape_read_packet()). `nblocks` is
 * the frame's known block (sample) count from the header/seektable — used to size the output
 * buffer once, up front. Returns samples decoded per channel, or a negative libav error code. */
EXPORT int audio_ape_decode(AudioApe *d, uint8_t *data, int size, int nblocks) {
	if (nblocks > d->cap) {
		float *bigger = realloc(d->out, sizeof(float) * (size_t)d->channels * nblocks);
		if (!bigger) return AVERROR(ENOMEM);
		d->out = bigger;
		d->cap = nblocks;
	}
	av_packet_unref(d->pkt);
	if (av_new_packet(d->pkt, size) < 0) return AVERROR(ENOMEM);
	memcpy(d->pkt->data, data, size);

	int ret = avcodec_send_packet(d->ctx, d->pkt);
	if (ret < 0) return ret;

	/* apedec.c decodes a frame's blocks_per_loop chunk at a time across several receive_frame
	 * calls; a truncated/corrupt packet can fail partway through. Keep whatever chunks already
	 * decoded (matches libavformat's own short-read tolerance — see decode-ape.js's flush()). */
	int filled = 0;
	for (;;) {
		int r = avcodec_receive_frame(d->ctx, d->frame);
		if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) break;
		if (r < 0) { if (filled) break; return r; }
		if (filled + d->frame->nb_samples > d->cap) { av_frame_unref(d->frame); break; } /* defensive: shouldn't happen, nblocks bounds it */
		conv_planar(d->ctx, d->frame, d->out, d->cap, filled);
		filled += d->frame->nb_samples;
		av_frame_unref(d->frame);
	}
	return filled;
}

EXPORT float *audio_ape_output(AudioApe *d) { return d ? d->out : NULL; }
EXPORT int audio_ape_channels(AudioApe *d) { return d ? d->channels : 0; }

EXPORT void audio_ape_destroy(AudioApe *d) {
	if (!d) return;
	if (d->frame) av_frame_free(&d->frame);
	if (d->pkt) av_packet_free(&d->pkt);
	if (d->ctx) avcodec_free_context(&d->ctx);
	free(d->out);
	free(d);
}
