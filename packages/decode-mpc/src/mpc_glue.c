#include <stdlib.h>
#include <string.h>
#include <mpc/mpcdec.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

/* libmpcdec/internal.h: MAX_FRAME_SIZE, the worst-case size of one compressed frame.
 * The demuxer's own per-frame fill request is bounded by this constant, so keeping this
 * many bytes buffered ahead of the reader's cursor before calling mpc_demux_decode()
 * guarantees the reader never has to report a short read mid-frame. A short read is not
 * safely retryable: mpc_demux_decode_inner() leaves no way to rewind a failed frame, so an
 * under-fed decode desyncs the bitstream position permanently. */
#define SAFE_MARGIN 4352

typedef struct {
	mpc_reader reader;
	mpc_demux *demux;
	mpc_streaminfo si;
	uint8_t *buf;   /* growable, never-discarded input; the SV8 seek-table round trip
	                   (header "SO" block) can seek backward to any earlier offset */
	uint32_t len;   /* bytes fed so far */
	uint32_t cap;
	uint32_t pos;   /* reader cursor */
	MPC_SAMPLE_FORMAT out[MPC_DECODER_BUFFER_LENGTH]; /* interleaved scratch, one frame */
} AudioMpc;

static mpc_int32_t r_read(mpc_reader *r, void *ptr, mpc_int32_t size) {
	AudioMpc *m = (AudioMpc *)r->data;
	mpc_int32_t avail = (mpc_int32_t)(m->len - m->pos);
	mpc_int32_t n = size < avail ? size : avail;
	if (n < 0) n = 0;
	if (n > 0) memcpy(ptr, m->buf + m->pos, (size_t)n);
	m->pos += (uint32_t)n;
	return n;
}
static mpc_bool_t r_seek(mpc_reader *r, mpc_int32_t offset) {
	AudioMpc *m = (AudioMpc *)r->data;
	if (offset < 0 || (uint32_t)offset > m->len) return MPC_FALSE;
	m->pos = (uint32_t)offset;
	return MPC_TRUE;
}
static mpc_int32_t r_tell(mpc_reader *r) { return (mpc_int32_t)((AudioMpc *)r->data)->pos; }
static mpc_int32_t r_size(mpc_reader *r) { return (mpc_int32_t)((AudioMpc *)r->data)->len; }
static mpc_bool_t r_canseek(mpc_reader *r) { (void)r; return MPC_TRUE; }

EXPORT AudioMpc *audio_mpc_create(void) {
	AudioMpc *m = calloc(1, sizeof(*m));
	if (!m) return NULL;
	m->reader.read = r_read;
	m->reader.seek = r_seek;
	m->reader.tell = r_tell;
	m->reader.get_size = r_size;
	m->reader.canseek = r_canseek;
	m->reader.data = m;
	return m;
}

/* Append bytes to the input buffer. Returns 0 on success, -1 on allocation failure. */
EXPORT int audio_mpc_feed(AudioMpc *m, const uint8_t *src, int n) {
	if (n <= 0) return 0;
	uint32_t need = m->len + (uint32_t)n;
	if (need > m->cap) {
		uint32_t cap = m->cap ? m->cap : 65536;
		while (cap < need) cap *= 2;
		uint8_t *b = realloc(m->buf, cap);
		if (!b) return -1;
		m->buf = b;
		m->cap = cap;
	}
	memcpy(m->buf + m->len, src, (size_t)n);
	m->len += (uint32_t)n;
	return 0;
}

/* Attempt to parse the stream header and initialize the demuxer.
 * Returns 1 on success, 0 if more bytes are needed (retry after the next feed),
 * -1 if this is definitely not a Musepack stream. */
EXPORT int audio_mpc_init(AudioMpc *m) {
	if (m->demux) return 1;
	if (m->len < 4) return 0;
	if (memcmp(m->buf, "MP+", 3) != 0 && memcmp(m->buf, "MPCK", 4) != 0) return -1;
	m->pos = 0; /* mpc_demux_init reads from the reader's current position; every retry starts fresh */
	mpc_demux *d = mpc_demux_init(&m->reader);
	if (!d) {
		/* mpc_demux_init() gives no reason for failure. A stream that still won't parse
		 * after a generous header budget (SV8 stream + seek-table + replaygain + encoder
		 * info blocks are all well under this) is malformed, not merely incomplete. */
		return m->len < (1 << 20) ? 0 : -1;
	}
	m->demux = d;
	mpc_demux_get_info(d, &m->si);
	return 1;
}

EXPORT int audio_mpc_channels(AudioMpc *m) { return (int)m->si.channels; }
EXPORT int audio_mpc_sample_rate(AudioMpc *m) { return (int)m->si.sample_freq; }
EXPORT int audio_mpc_stream_version(AudioMpc *m) { return (int)m->si.stream_version; }

/* Bytes fed but not yet consumed by the reader cursor. */
EXPORT int audio_mpc_avail(AudioMpc *m) { return (int)(m->len - m->pos); }

/* Decode one frame. Returns samples per channel (>0), 0 at clean end of stream,
 * -1 on a corrupt/desynced frame -- the demux position is no longer trustworthy
 * and no further calls should be made on this instance. */
EXPORT int audio_mpc_decode(AudioMpc *m) {
	mpc_frame_info fi;
	fi.buffer = m->out;
	if (mpc_demux_decode(m->demux, &fi) != MPC_STATUS_OK) return -1;
	if (fi.bits == -1) return 0;
	return (int)fi.samples;
}

EXPORT MPC_SAMPLE_FORMAT *audio_mpc_output(AudioMpc *m) { return m->out; }

EXPORT void audio_mpc_destroy(AudioMpc *m) {
	if (!m) return;
	if (m->demux) mpc_demux_exit(m->demux);
	free(m->buf);
	free(m);
}
