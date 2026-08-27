/**
 * AC-3 decoder — liba52 compiled to WASM (single-file ES module, host-neutral).
 * Decodes raw AC-3 frame streams; container demuxers (@audio/decode-mp4, -webm, -avi) feed it their AC-3 tracks.
 * Output keeps the stream's own layout, channels in WAV order: FL, FR, FC, LFE, BL, BR (surround-only / mono as present).
 *
 * let { channelData, sampleRate } = await decode(ac3buf)
 * let dec = await decoder(); let result = dec.decode(chunk)
 */
import createAC3 from './src/ac3.wasm.js'

const EMPTY = Object.freeze({ channelData: [], sampleRate: 0 })
const HEADER = 7        // bytes needed to parse a frame header
const MAX_LEFT = 65536   // partial-frame carry-over cap

let modP
function getMod() {
	if (modP) return modP
	let p = createAC3()
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
	return new AC3Decoder(await getMod())
}

class AC3Decoder {
	constructor(m) {
		this.m = m
		this.h = m._audio_ac3_create()
		if (!this.h) throw Error('AC-3 decoder allocation failed')
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
			let len = m._audio_ac3_syncinfo(this.h, ptr)
			if (!len) { pos++; continue }
			if (pos + len > buf.length) break // partial frame — wait for more
			ptr = this.alloc(len)
			m.HEAPU8.set(buf.subarray(pos, pos + len), ptr)
			let n = m._audio_ac3_decode(this.h, ptr)
			pos += len
			if (n < 0) { this.errors++; continue }
			let nch = m._audio_ac3_channels(this.h), out = m._audio_ac3_output(this.h) >> 2
			let flags = m._audio_ac3_flags(this.h)
			sampleRate = m._audio_ac3_sample_rate(this.h)
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
		this.m._audio_ac3_destroy(this.h); this.h = 0
		if (this.ptr) this.m._free(this.ptr)
		this.ptr = 0; this.cap = 0; this.left = null
	}

	alloc(len) {
		if (len > this.cap) {
			if (this.ptr) this.m._free(this.ptr)
			this.cap = len
			this.ptr = this.m._malloc(len)
			if (!this.ptr) throw Error('AC-3: out of WASM memory')
		}
		return this.ptr
	}
}

// liba52 output: LFE first (when present), then the layout's channels in liba52 order.
// Map to WAV order per layout code (A52_* in a52.h): indexes into liba52's planar output.
const ORDER = {
	0: [0, 1], 1: [0], 2: [0, 1], 8: [0], 9: [0], 10: [0, 1],
	3: [0, 2, 1],            // 3F:   L C R        → FL FR FC
	4: [0, 1, 2],            // 2F1R: L R S        → FL FR S
	5: [0, 2, 1, 3],         // 3F1R: L C R S      → FL FR FC S
	6: [0, 1, 2, 3],         // 2F2R: L R SL SR    → FL FR BL BR
	7: [0, 2, 1, 3, 4],      // 3F2R: L C R SL SR  → FL FR FC BL BR
}

function reorder(chs, flags) {
	let lfe = flags & 16, map = ORDER[flags & 15] || chs.map((_, i) => i)
	let base = lfe ? 1 : 0
	let out = map.map(i => chs[base + i])
	if (lfe) out.splice(Math.min(3, out.length), 0, chs[0]) // LFE takes the WAV slot after FC
	return out
}

function merge(a, b) {
	if (!b?.channelData?.length) return a
	if (!a?.channelData?.length) return b
	return { channelData: a.channelData.map((ch, i) => { let m = new Float32Array(ch.length + b.channelData[i].length); m.set(ch); m.set(b.channelData[i], ch.length); return m }), sampleRate: a.sampleRate }
}
