/**
 * E-AC-3 (Dolby Digital Plus) decoder — FFmpeg's `eac3` libavcodec decoder (LGPL-2.1-or-later)
 * compiled to a single-file WASM ES module. The same decoder function also parses plain AC-3
 * frames (bitstream_id <= 10 — see libavcodec/ac3dec.c parse_frame_header()), so this package
 * decodes both raw AC-3 and E-AC-3 sync-frame streams (.ac3 / .ec3 / .eac3); container demuxers
 * (@audio/decode-mp4, -webm, -avi) route their E-AC-3 tracks here.
 *
 * Sync-frame framing (syncword 0x0B77, frame size from ffmpeg's public av_ac3_parse_header —
 * frmsiz for E-AC-3, the frmsizecod/fscod table for classic AC-3, see libavcodec/ac3_parser.c) is
 * cut in JS, one packet per frame — same shape as @audio/decode-ac3. Output channels come out in
 * WAV order already: ffmpeg's ac3 decoder builds a native (bitmask) AVChannelLayout, and native
 * layouts order channels by ascending AV_CH_* bit value, which is WAV order (FL, FR, FC, LFE, BL,
 * BR, …) — see src/eac3_glue.c. Dynamic range compression (drc_scale) is forced to 0 so output
 * stays full-scale with no gain applied, matching @audio/decode-ac3 (liba52, no dialnorm/DRC).
 *
 * let { channelData, sampleRate } = await decode(eac3buf)
 * let dec = await decoder(); let result = dec.decode(chunk)
 */
import createEac3 from './src/eac3.wasm.js'

const EMPTY = Object.freeze({ channelData: [], sampleRate: 0 })
const HEADER = 8          // bytes av_ac3_parse_header needs to read through channel_mode/lfe_on (7 for AC-3, less for E-AC-3) — see libavcodec/ac3_parser.c ff_ac3_parse_header
const MAX_SAMPLES = 1536  // AC3_MAX_BLOCKS(6) * AC3_BLOCK_SIZE(256) — one sync frame, matches src/eac3_glue.c's output stride
const MAX_LEFT = 65536    // partial-frame carry-over cap

let modP
function getMod() {
	if (modP) return modP
	let p = createEac3()
	modP = p
	return p.catch(e => { modP = null; throw e })
}

/**
 * Whole-file decode
 * @param {Uint8Array|ArrayBuffer} src
 * @returns {Promise<{channelData: Float32Array[], sampleRate: number}>}
 */
export default async function decode(src) {
	let buf = src instanceof Uint8Array ? src : new Uint8Array(src)
	let dec = await decoder()
	try { return merge(dec.decode(buf), dec.flush()) }
	finally { dec.free() }
}

/** Create streaming decoder instance — decode() and flush() are synchronous. */
export async function decoder() {
	return new Eac3Decoder(await getMod())
}

class Eac3Decoder {
	constructor(m) {
		this.m = m
		this.h = m._audio_eac3_create()
		if (!this.h) throw Error('E-AC-3 decoder allocation failed')
		this.ptr = 0; this.cap = 0
		this.left = null
		this.errors = 0
		this.freed = false
	}

	decode(data) {
		if (this.freed) throw Error('Decoder already freed')
		if (!data || !data.byteLength) return EMPTY
		let buf = data instanceof Uint8Array ? data : new Uint8Array(data)
		if (this.left) { let j = new Uint8Array(this.left.length + buf.length); j.set(this.left); j.set(buf, this.left.length); buf = j; this.left = null }

		let m = this.m, parts = [], pos = 0, sampleRate = 0, channels = 0
		while (pos + HEADER <= buf.length) {
			if (!(buf[pos] === 0x0B && buf[pos + 1] === 0x77)) { pos++; continue }
			let ptr = this.alloc(HEADER)
			m.HEAPU8.set(buf.subarray(pos, pos + HEADER), ptr)
			let len = m._audio_eac3_syncinfo(ptr, HEADER)
			if (!len) { pos++; continue }
			if (pos + len > buf.length) break // partial frame — wait for more
			ptr = this.alloc(len)
			m.HEAPU8.set(buf.subarray(pos, pos + len), ptr)
			let n = m._audio_eac3_decode(this.h, ptr, len)
			pos += len
			if (n < 0) { this.errors++; continue }
			if (n > 0) {
				let nch = m._audio_eac3_channels(this.h), out = m._audio_eac3_output(this.h) >> 2
				sampleRate = m._audio_eac3_sample_rate(this.h)
				channels = nch
				parts.push(Array.from({ length: nch }, (_, c) => m.HEAPF32.slice(out + c * MAX_SAMPLES, out + c * MAX_SAMPLES + n)))
			}
		}
		if (pos < buf.length) this.left = buf.length - pos <= MAX_LEFT ? buf.subarray(pos).slice() : null
		if (!parts.length) return EMPTY
		let total = parts.reduce((s, p) => s + p[0].length, 0)
		let channelData = Array.from({ length: channels }, (_, c) => {
			let o = new Float32Array(total), off = 0
			for (let p of parts) { o.set(p[c], off); off += p[c].length }
			return o
		})
		return { channelData, sampleRate }
	}

	flush() { this.left = null; return EMPTY }

	free() {
		if (this.freed) return
		this.freed = true
		this.m._audio_eac3_destroy(this.h); this.h = 0
		if (this.ptr) this.m._free(this.ptr)
		this.ptr = 0; this.cap = 0; this.left = null
	}

	alloc(len) {
		if (len > this.cap) {
			if (this.ptr) this.m._free(this.ptr)
			this.cap = len
			this.ptr = this.m._malloc(len)
			if (!this.ptr) throw Error('E-AC-3: out of WASM memory')
		}
		return this.ptr
	}
}

function merge(a, b) {
	if (!b?.channelData?.length) return a
	if (!a?.channelData?.length) return b
	return { channelData: a.channelData.map((ch, i) => { let m = new Float32Array(ch.length + b.channelData[i].length); m.set(ch); m.set(b.channelData[i], ch.length); return m }), sampleRate: a.sampleRate }
}
