/**
 * DTS decoder — libdca compiled to WASM (single-file ES module, host-neutral).
 * Decodes raw DTS frame streams; container demuxers (@audio/decode-mp4, -webm, -avi) feed it their DTS tracks.
 * Output keeps the stream's own layout, channels in WAV order: FL, FR, FC, LFE, BL, BR (surround-only / mono as present).
 *
 * let { channelData, sampleRate } = await decode(dtsbuf)
 * let dec = await decoder(); let result = dec.decode(chunk)
 */
import createDTS from './src/dts.wasm.js'

const EMPTY = Object.freeze({ channelData: [], sampleRate: 0 })
const HEADER = 16        // bytes needed to parse a frame header
const MAX_LEFT = 65536   // partial-frame carry-over cap

let modP
function getMod() {
	if (modP) return modP
	let p = createDTS()
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
	return new DTSDecoder(await getMod())
}

class DTSDecoder {
	constructor(m) {
		this.m = m
		this.h = m._audio_dts_create()
		if (!this.h) throw Error('DTS decoder allocation failed')
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
			if (!(isSync(buf, pos))) { pos++; continue }
			let ptr = this.alloc(HEADER)
			m.HEAPU8.set(buf.subarray(pos, pos + HEADER), ptr)
			let len = m._audio_dts_syncinfo(this.h, ptr)
			if (!len) { pos++; continue }
			if (pos + len > buf.length) break // partial frame — wait for more
			ptr = this.alloc(len)
			m.HEAPU8.set(buf.subarray(pos, pos + len), ptr)
			let n = m._audio_dts_decode(this.h, ptr)
			pos += len
			if (n < 0) { this.errors++; continue }
			let nch = m._audio_dts_channels(this.h), out = m._audio_dts_output(this.h) >> 2
			let flags = m._audio_dts_flags(this.h)
			sampleRate = m._audio_dts_sample_rate(this.h)
			channels = nch
			parts.push(reorder(Array.from({ length: nch }, (_, c) => m.HEAPF32.slice(out + c * n, out + (c + 1) * n)), flags))
		}
		if (pos < buf.length) this.left = buf.length - pos <= MAX_LEFT ? buf.subarray(pos).slice() : null
		if (!parts.length) return EMPTY
		let total = parts.reduce((s, p) => s + p[0].length, 0)
		let channelData = Array.from({ length: channels }, (_, c) => {
			let o = new Float32Array(total), off = 0
			for (let p of parts) { o.set(p[c] ?? p[0], off); off += p[0].length }
			return o
		})
		return { channelData, sampleRate }
	}

	flush() { this.left = null; return EMPTY }

	free() {
		if (this.freed) return
		this.freed = true
		this.m._audio_dts_destroy(this.h); this.h = 0
		if (this.ptr) this.m._free(this.ptr)
		this.ptr = 0; this.cap = 0; this.left = null
	}

	alloc(len) {
		if (len > this.cap) {
			if (this.ptr) this.m._free(this.ptr)
			this.cap = len
			this.ptr = this.m._malloc(len)
			if (!this.ptr) throw Error('DTS: out of WASM memory')
		}
		return this.ptr
	}
}

// DTS core syncwords: 16-bit BE, 16-bit LE, 14-bit BE, 14-bit LE
function isSync(b, p) {
	return (b[p] === 0x7F && b[p + 1] === 0xFE && b[p + 2] === 0x80 && b[p + 3] === 0x01) ||
		(b[p] === 0xFE && b[p + 1] === 0x7F && b[p + 2] === 0x01 && b[p + 3] === 0x80) ||
		(b[p] === 0x1F && b[p + 1] === 0xFF && b[p + 2] === 0xE8 && b[p + 3] === 0x00) ||
		(b[p] === 0xFF && b[p + 1] === 0x1F && b[p + 2] === 0x00 && b[p + 3] === 0xE8)
}

// libdca output: the layout's channels in DTS bitstream order (C before L R — verified against ffmpeg on 5.1),
// LFE last (when present). Map to WAV order per layout code (DCA_* in dca.h).
const ORDER = {
	0: [0], 1: [0, 1], 2: [0, 1], 3: [0, 1], 4: [0, 1],
	5: [1, 2, 0],            // 3F:   C L R        → FL FR FC
	6: [0, 1, 2],            // 2F1R: L R S        → FL FR S
	7: [1, 2, 0, 3],         // 3F1R: C L R S      → FL FR FC S
	8: [0, 1, 2, 3],         // 2F2R: L R SL SR    → FL FR BL BR
	9: [1, 2, 0, 3, 4],      // 3F2R: C L R SL SR  → FL FR FC BL BR
	10: [0, 1, 2, 3, 4, 5],
}

function reorder(chs, flags) {
	let lfe = flags & 0x80, map = ORDER[flags & 0x3F] || chs.map((_, i) => i)
	let out = map.map(i => chs[i])
	if (lfe) out.splice(Math.min(3, out.length), 0, chs[chs.length - 1]) // LFE takes the WAV slot after FC
	return out
}

function merge(a, b) {
	if (!b?.channelData?.length) return a
	if (!a?.channelData?.length) return b
	return { channelData: a.channelData.map((ch, i) => { let m = new Float32Array(ch.length + b.channelData[i].length); m.set(ch); m.set(b.channelData[i], ch.length); return m }), sampleRate: a.sampleRate }
}
