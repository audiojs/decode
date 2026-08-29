#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <wavpack.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

#define BATCH 4096              /* samples-per-channel pulled per WavpackUnpackSamples() call */
#define ERR_LEN 128

/* Memory-backed "file" the WavpackStreamReader64 reads from. JS appends whole blocks to the
   tail (wv_reserve/wv_feed); the library reads them via the callbacks below, exactly as it
   would read a real file — it copies each block into its own buffer as it goes, so nothing
   here needs to be retained once read. */
typedef struct {
	unsigned char *buf;
	int64_t len, cap, pos;
} Mem;

typedef struct {
	WavpackContext *ctx;
	WavpackStreamReader64 rd;
	Mem in;
	int32_t *out;
	int64_t out_len, out_cap;
	int last_errs;
	char err[ERR_LEN];
} WvDecoder;

static int32_t rd_read(void *id, void *data, int32_t bcount) {
	Mem *m = (Mem *)id;
	int64_t avail = m->len - m->pos;
	if (avail < 0) avail = 0;
	int32_t n = bcount < avail ? bcount : (int32_t)avail;
	if (n > 0) { memcpy(data, m->buf + m->pos, n); m->pos += n; }
	return n;
}
static int32_t rd_write(void *id, void *data, int32_t bcount) { (void)id; (void)data; (void)bcount; return 0; }
static int64_t rd_get_pos(void *id) { return ((Mem *)id)->pos; }
static int rd_set_pos_abs(void *id, int64_t pos) {
	Mem *m = (Mem *)id;
	if (pos < 0 || pos > m->len) return 1;
	m->pos = pos;
	return 0;
}
static int rd_set_pos_rel(void *id, int64_t delta, int mode) {
	Mem *m = (Mem *)id;
	int64_t base = mode == SEEK_CUR ? m->pos : mode == SEEK_END ? m->len : 0;
	int64_t p = base + delta;
	if (p < 0 || p > m->len) return 1;
	m->pos = p;
	return 0;
}
static int rd_push_back(void *id, int c) {
	Mem *m = (Mem *)id;
	if (m->pos > 0) m->pos--;
	return c;
}
static int64_t rd_get_length(void *id) { return ((Mem *)id)->len; }
static int rd_can_seek(void *id) { (void)id; return 1; }
static int rd_truncate(void *id) { (void)id; return 0; }
static int rd_close(void *id) { (void)id; return 0; }

EXPORT WvDecoder *wv_create(void) {
	WvDecoder *d = calloc(1, sizeof(*d));
	if (!d) return NULL;
	d->rd.read_bytes = rd_read;
	d->rd.write_bytes = rd_write;
	d->rd.get_pos = rd_get_pos;
	d->rd.set_pos_abs = rd_set_pos_abs;
	d->rd.set_pos_rel = rd_set_pos_rel;
	d->rd.push_back_byte = rd_push_back;
	d->rd.get_length = rd_get_length;
	d->rd.can_seek = rd_can_seek;
	d->rd.truncate_here = rd_truncate;
	d->rd.close = rd_close;
	return d;
}

/* Ensure room for `extra` more input bytes at the tail of the memory-backed reader; returns
   the write pointer. JS fills it (whole WavPack blocks only), then calls wv_feed(). */
EXPORT unsigned char *wv_reserve(WvDecoder *d, int32_t extra) {
	int64_t need = d->in.len + extra;
	if (need > d->in.cap) {
		int64_t cap = d->in.cap ? d->in.cap * 2 : 4096;
		while (cap < need) cap *= 2;
		unsigned char *p = realloc(d->in.buf, cap);
		if (!p) return NULL;
		d->in.buf = p;
		d->in.cap = cap;
	}
	return d->in.buf + d->in.len;
}

static int out_reserve(WvDecoder *d, int64_t samples) {
	if (samples > d->out_cap) {
		int32_t *p = realloc(d->out, samples * sizeof(int32_t));
		if (!p) return 0;
		d->out = p;
		d->out_cap = samples;
	}
	return 1;
}

static void set_err(WvDecoder *d, const char *msg) {
	strncpy(d->err, msg, ERR_LEN - 1);
	d->err[ERR_LEN - 1] = 0;
}

/* Commit `n` bytes just written at wv_reserve()'s pointer (whole WavPack blocks) and drain
   every sample the library can produce from them. Opens the context lazily on first call, once
   the first block is available. Returns samples-per-channel decoded this call, or -1 on an
   unrecoverable stream error (see wv_error). */
EXPORT int32_t wv_feed(WvDecoder *d, int32_t n) {
	d->in.len += n;
	d->out_len = 0;

	if (!d->ctx) {
		char error[ERR_LEN] = { 0 };
		d->ctx = WavpackOpenFileInputEx64(&d->rd, &d->in, NULL, error,
			OPEN_NORMALIZE | OPEN_DSD_AS_PCM | OPEN_STREAMING, 0);
		if (!d->ctx) {
			set_err(d, error[0] ? error : "WavPack: cannot open stream");
			return -1;
		}
	}

	int channels = WavpackGetNumChannels(d->ctx);
	if (channels < 1) return 0;

	for (;;) {
		if (!out_reserve(d, d->out_len + (int64_t)BATCH * channels)) {
			set_err(d, "WavPack: out of memory");
			return -1;
		}
		uint32_t got = WavpackUnpackSamples(d->ctx, d->out + d->out_len, BATCH);
		if (!got) break;
		d->out_len += (int64_t)got * channels;
	}

	int errs = WavpackGetNumErrors(d->ctx);
	if (errs > d->last_errs) {
		d->last_errs = errs;
		set_err(d, "WavPack: corrupt block (checksum or discontinuity)");
		return -1;
	}

	return (int32_t)(d->out_len / channels);
}

EXPORT int32_t *wv_output(WvDecoder *d) { return d->out; }
EXPORT int wv_channels(WvDecoder *d) { return d->ctx ? WavpackGetNumChannels(d->ctx) : 0; }
EXPORT int wv_rate(WvDecoder *d) { return d->ctx ? (int)WavpackGetSampleRate(d->ctx) : 0; }
EXPORT int wv_bits(WvDecoder *d) { return d->ctx ? WavpackGetBitsPerSample(d->ctx) : 0; }
EXPORT int wv_is_float(WvDecoder *d) { return d->ctx ? (WavpackGetMode(d->ctx) & MODE_FLOAT) != 0 : 0; }
EXPORT int wv_is_lossless(WvDecoder *d) { return d->ctx ? (WavpackGetMode(d->ctx) & MODE_LOSSLESS) != 0 : 0; }
EXPORT char *wv_error(WvDecoder *d) { return d->err; }

EXPORT void wv_destroy(WvDecoder *d) {
	if (!d) return;
	if (d->ctx) WavpackCloseFile(d->ctx);
	free(d->in.buf);
	free(d->out);
	free(d);
}
