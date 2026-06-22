/**
 * AAC decoder — FAAD2 compiled to WASM
 * Decodes M4A (MP4/AAC) and raw ADTS streams. M4A files carrying ALAC
 * (Apple Lossless) are decoded by the pure-JS ALAC decoder instead.
 *
 * let { channelData, sampleRate } = await decode(m4abuf)
 */

import { createALAC } from './alac.js'

let _modP

async function getMod() {
	if (_modP) return _modP
	let p = (async () => {
		let createAAC
		if (typeof process !== 'undefined' && process.versions?.node) {
			let m = 'module'
			let { createRequire } = await import(m)
			createAAC = createRequire(import.meta.url)('./src/aac.wasm.cjs')
		} else {
			let mod = await import('./src/aac.wasm.cjs')
			createAAC = mod.default || mod
		}
		return createAAC()
	})()
	_modP = p
	try { return await p }
	catch (e) { _modP = null; throw e }
}

/**
 * Whole-file decode
 * @param {Uint8Array|ArrayBuffer} src
 * @returns {Promise<{channelData: Float32Array[], sampleRate: number}>}
 */
export default async function decode(src) {
	let buf = src instanceof Uint8Array ? src : new Uint8Array(src)
	let dec = await decoder()
	try {
		return dec.decode(buf)
	} finally {
		dec.free()
	}
}

/**
 * Create decoder instance
 * @returns {Promise<{decode(chunk: Uint8Array): {channelData, sampleRate}, flush(), free()}>}
 */
export async function decoder() {
	return new AACDecoder(await getMod())
}

const EMPTY = Object.freeze({ channelData: [], sampleRate: 0 })

class AACDecoder {
	constructor(mod) {
		this.m = mod
		this.h = null
		this.sr = 0
		this.ch = 0
		this.done = false
		this._ptr = 0
		this._cap = 0
		this._left = null
		this._fileOff = 0     // absolute file offset of _left[0] (M4A streaming)
		this._skip = 0        // bytes to discard from incoming data (M4A streaming, when next frame is past _left)
		this._m4a = null      // M4A streaming iterator: { sizes, stco, stsc, idx, ci, sInC, spc, nextOff }
		this._accum = null    // Uint8Array[] — M4A header accumulator
		this._accumLen = 0
		this._alac = null     // ALAC decoder when the M4A carries Apple Lossless
	}

	decode(data) {
		if (this.done) throw Error('Decoder already freed')
		if (!data?.length) return EMPTY

		let buf = data instanceof Uint8Array ? data : new Uint8Array(data)

		if (this._m4a) return this._feedM4AData(buf)
		if (this.h) return this._decodeADTS(buf)
		// M4A: accumulating moov+mdat header, or first chunk starts with ftyp
		if (this._accum || (buf.length > 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70)) {
			(this._accum ??= []).push(buf)
			this._accumLen += buf.length
			return this._tryM4AInit()
		}
		return this._decodeADTS(buf)
	}

	flush() {
		this._left = null
		return EMPTY
	}

	free() {
		if (this.done) return
		this.done = true
		if (this.h) {
			this.m._aac_close(this.h)
			this.m._aac_free_buf()
			this.h = null
		}
		if (this._ptr) {
			this.m._free(this._ptr)
			this._ptr = 0
			this._cap = 0
		}
		this._accum = null; this._accumLen = 0
		this._m4a = null; this._left = null; this._alac = null
		this._fileOff = 0; this._skip = 0
	}

	_catAccum() {
		if (this._accum.length === 1) return this._accum[0]
		let buf = new Uint8Array(this._accumLen), off = 0
		for (let c of this._accum) { buf.set(c, off); off += c.length }
		return buf
	}

	_tryM4AInit() {
		let buf = this._catAccum()
		let asc = null, alacCookie = null, stsz = null, stco = null, stsc = null

		parseBoxes(buf, 0, buf.length, (type, data) => {
			if (type === 'esds') asc = parseEsds(data)
			else if (type === 'alac') alacCookie = data // ALAC magic cookie: version/flags(4) + ALACSpecificConfig(24)
			else if (type === 'stsz') stsz = parseStsz(data)
			else if (type === 'stco') stco = parseStco(data)
			else if (type === 'co64') stco = parseCo64(data)
			else if (type === 'stsc') stsc = parseStsc(data)
		})

		if ((!asc && !alacCookie) || !stsz || !stco?.length) return EMPTY // moov/tables not ready

		if (alacCookie) {
			// ALAC (Apple Lossless) — pure JS, no FAAD2
			this._alac = createALAC(alacCookie.subarray(4))
			this.sr = this._alac.config.sampleRate
			this.ch = this._alac.config.numChannels
		} else {
			// Init WASM decoder with ASC
			let m = this.m, h = m._aac_create()
			let srP = m._aac_sr_ptr(), chP = m._aac_ch_ptr()
			let ptr = this._alloc(asc.length)
			m.HEAPU8.set(asc, ptr)
			let err = m._aac_init2(h, ptr, asc.length, srP, chP)
			if (err < 0) { m._aac_close(h); throw Error('M4A init failed (code ' + err + ')') }
			this.sr = m.getValue(srP, 'i32')
			this.ch = m.getValue(chP, 'i8')
			if (!this.ch) { m._aac_close(h); throw Error('M4A init: no channels in ASC') }
			this.h = h
		}

		// Streaming: walk sample tables by absolute file offset so chunk boundaries are irrelevant.
		this._accum = null; this._accumLen = 0
		this._m4a = { sizes: stsz, stco, stsc, idx: 0, ci: 0, sInC: 0, spc: spcAt(0, stsc), nextOff: stco[0] }
		this._left = buf
		this._fileOff = 0
		this._skip = 0
		return this._extractM4A()
	}

	_feedM4AData(buf) {
		if (this._skip > 0) {
			let n = Math.min(this._skip, buf.length)
			this._skip -= n
			this._fileOff += n
			buf = buf.subarray(n)
			if (!buf.length) return EMPTY
		}
		this._left = append(this._left, buf)
		return this._extractM4A()
	}

	_extractM4A() {
		let st = this._m4a, frames = []
		while (st.idx < st.sizes.length) {
			let off = st.nextOff, sz = st.sizes[st.idx]
			let bufOff = off - this._fileOff
			if (bufOff + sz > this._left.length) break
			if (bufOff >= 0) frames.push(this._left.subarray(bufOff, bufOff + sz))
			advanceM4A(st)
		}

		if (st.idx < st.sizes.length) {
			let nextOff = st.nextOff, end = this._fileOff + this._left.length
			if (nextOff >= end) {
				this._skip = nextOff - end
				this._fileOff = end
				this._left = null
			} else if (nextOff > this._fileOff) {
				this._left = this._left.subarray(nextOff - this._fileOff).slice()
				this._fileOff = nextOff
			}
		} else {
			this._left = null
		}

		return frames.length ? this._feedFrames(frames) : EMPTY
	}

	_alloc(len) {
		if (len > this._cap) {
			if (this._ptr) this.m._free(this._ptr)
			this._cap = len
			this._ptr = this.m._malloc(len)
		}
		return this._ptr
	}

	_decodeADTS(buf) {
		let m = this.m

		if (this._left) { buf = append(this._left, buf); this._left = null }

		if (!this.h) {
			if (buf.length < 7) { this._left = buf.slice(); return EMPTY }
			let h = m._aac_create()
			let srP = m._aac_sr_ptr(), chP = m._aac_ch_ptr()
			let ptr = this._alloc(buf.length)
			m.HEAPU8.set(buf, ptr)
			let consumed = m._aac_init(h, ptr, buf.length, srP, chP)
			if (consumed < 0) { m._aac_close(h); throw Error('ADTS init failed (code ' + consumed + ')') }
			this.sr = m.getValue(srP, 'i32')
			this.ch = m.getValue(chP, 'i8')
			if (!this.ch) {
				// not enough data to detect channels — buffer for next call
				m._aac_close(h)
				this._left = buf.length < 8192 ? buf.slice() : null
				return EMPTY
			}
			this.h = h
			buf = buf.subarray(consumed)
		}

		// extract complete ADTS frames only — never feed partial data to FAAD2
		let frames = [], pos = 0
		while (pos + 6 < buf.length) {
			if (buf[pos] !== 0xFF || (buf[pos + 1] & 0xF6) !== 0xF0) { pos++; continue }
			let flen = ((buf[pos + 3] & 0x03) << 11) | (buf[pos + 4] << 3) | (buf[pos + 5] >> 5)
			if (flen < 7 || pos + flen > buf.length) break
			frames.push(buf.subarray(pos, pos + flen))
			pos += flen
		}

		if (pos < buf.length) {
			let left = buf.subarray(pos)
			this._left = left.length < 8192 ? left.slice() : null
		}

		if (!frames.length) return EMPTY
		return this._feedFrames(frames)
	}

	_feedFrames(frames) {
		if (this._alac) return this._feedALAC(frames)
		let m = this.m, h = this.h
		let chunks = [], totalPerCh = 0, channels = this.ch, errors = 0

		for (let frame of frames) {
			let ptr = this._alloc(frame.length)
			m.HEAPU8.set(frame, ptr)
			let out = m._aac_decode(h, ptr, frame.length)
			if (!out) { errors++; continue }

			let n = m._aac_samples()
			let sr = m._aac_samplerate()
			if (sr) this.sr = sr
			let ch = m._aac_channels()
			if (ch) channels = ch

			let spc = n / channels
			chunks.push({ data: new Float32Array(m.HEAPF32.buffer, out, n).slice(), ch: channels, spc })
			totalPerCh += spc
		}

		if (!totalPerCh) return EMPTY

		let channelData = Array.from({ length: channels }, () => new Float32Array(totalPerCh))
		let pos = 0
		for (let { data, ch, spc } of chunks) {
			for (let c = 0; c < ch; c++) {
				let out = channelData[c]
				for (let s = 0; s < spc; s++) out[pos + s] = data[s * ch + c]
			}
			pos += spc
		}

		return { channelData, sampleRate: this.sr, errors }
	}

	_feedALAC(frames) {
		let channels = this.ch, parts = [], total = 0
		for (let frame of frames) {
			let r = this._alac.decodeFrame(frame)
			parts.push(r.channelData)
			total += r.numSamples
		}
		if (!total) return EMPTY
		let channelData = Array.from({ length: channels }, () => new Float32Array(total))
		let pos = 0
		for (let cd of parts) {
			let n = cd[0].length
			for (let c = 0; c < channels; c++) channelData[c].set(cd[c], pos)
			pos += n
		}
		return { channelData, sampleRate: this.sr }
	}
}


// ===== M4A demuxer =====

function append(left, buf) {
	if (!left?.length) return buf.slice()
	let merged = new Uint8Array(left.length + buf.length)
	merged.set(left); merged.set(buf, left.length)
	return merged
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'meta', 'edts', 'sinf'])

function parseBoxes(buf, start, end, cb) {
	let off = start
	while (off < end - 8) {
		let size = r32(buf, off)
		let type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7])

		if (size === 0) size = end - off
		else if (size === 1 && off + 16 <= end) {
			size = r32(buf, off + 12)
			if (size < 16) break
		} else if (size < 8) break

		// skip mdat fast — the raw frames don't interest us here
		if (type === 'mdat') { off += size; continue }
		// truncated non-mdat box: tables would be garbage — wait for more data
		if (off + size > end) break

		let bodyOff = off + 8
		if (type === 'stsd') parseSampleDesc(buf, bodyOff, size - 8, cb)
		else if (CONTAINERS.has(type)) parseBoxes(buf, bodyOff + (type === 'meta' ? 4 : 0), off + size, cb)
		else cb(type, buf.subarray(bodyOff, off + size))

		off += size
	}
}

function parseSampleDesc(buf, off, len, cb) {
	let entries = r32(buf, off + 4), pos = off + 8
	for (let i = 0; i < entries && pos < off + len; i++) {
		let eSize = r32(buf, pos)
		let eType = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7])
		// recurse into the audio sample entry so its child boxes (esds for AAC, alac cookie for ALAC) surface
		if ((eType === 'mp4a' || eType === 'alac') && eSize > 36) parseBoxes(buf, pos + 36, pos + eSize, cb)
		pos += eSize
	}
}

function parseEsds(data) {
	let off = 4
	while (off < data.length - 2) {
		let tag = data[off++], len = 0, b
		do { b = data[off++]; len = (len << 7) | (b & 0x7f) } while (b & 0x80 && off < data.length)
		if (tag === 0x03) off += 3
		else if (tag === 0x04) off += 13
		else if (tag === 0x05) return data.subarray(off, off + len)
		else off += len
	}
	return null
}

function parseStsz(data) {
	let sz = r32(data, 4), n = r32(data, 8)
	if (sz) return Array(n).fill(sz)
	let sizes = new Array(n)
	for (let i = 0; i < n; i++) sizes[i] = r32(data, 12 + i * 4)
	return sizes
}

function parseStco(data) {
	let n = r32(data, 4), o = new Array(n)
	for (let i = 0; i < n; i++) o[i] = r32(data, 8 + i * 4)
	return o
}

function parseCo64(data) {
	let n = r32(data, 4), o = new Array(n)
	for (let i = 0; i < n; i++) o[i] = r32(data, 8 + i * 8 + 4)
	return o
}

function parseStsc(data) {
	let n = r32(data, 4), e = new Array(n)
	for (let i = 0; i < n; i++) e[i] = { first: r32(data, 8 + i * 12), spc: r32(data, 12 + i * 12) }
	return e
}

function spcAt(ci, stsc) {
	if (!stsc?.length) return 1
	let spc = 1, cn = ci + 1
	for (let j = stsc.length - 1; j >= 0; j--)
		if (cn >= stsc[j].first) { spc = stsc[j].spc; break }
	return spc
}

function advanceM4A(st) {
	st.nextOff += st.sizes[st.idx]
	st.idx++
	st.sInC++
	if (st.sInC >= st.spc && st.ci + 1 < st.stco.length) {
		st.ci++
		st.sInC = 0
		st.spc = spcAt(st.ci, st.stsc)
		st.nextOff = st.stco[st.ci]
	}
}

function r32(buf, off) {
	return (buf[off] << 24 | buf[off + 1] << 16 | buf[off + 2] << 8 | buf[off + 3]) >>> 0
}
