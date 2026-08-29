/**
 * MP4 / MOV / M4A / M4V / 3GP audio decoder — ISO BMFF demuxer that routes the audio track to a codec:
 * AAC, ALAC → @audio/decode-aac · MP3 → @audio/decode-mp3 · FLAC → @audio/decode-flac
 * Opus → @audio/decode-opus/core · AMR → @audio/decode-amr · AC-3 → @audio/decode-ac3 · E-AC-3 → @audio/decode-eac3
 * DTS → @audio/decode-dts · PCM / µ-law / A-law inline.
 *
 * let { channelData, sampleRate } = await decode(mp4buf)
 * let dec = await decoder(); let result = await dec.decode(chunk)
 */

const EMPTY = Object.freeze({ channelData: [], sampleRate: 0 })

/**
 * Whole-file decode
 * @param {Uint8Array|ArrayBuffer} src
 * @returns {Promise<{channelData: Float32Array[], sampleRate: number}>}
 */
export default async function decode(src) {
	if (!src || typeof src === 'string' || !(src.buffer || src.byteLength != null || src.length))
		throw TypeError('Expected ArrayBuffer or Uint8Array')
	let buf = src instanceof Uint8Array ? src : new Uint8Array(src.buffer || src)
	let dec = new MP4Decoder()
	try {
		let result = await dec.decode(buf)
		return merge(result, await dec.flush())
	} finally { dec.free() }
}

/**
 * Create streaming decoder instance. decode() is synchronous once the track header (moov) has been
 * seen; the call that completes the header returns a Promise while the codec module loads.
 */
export async function decoder() {
	return new MP4Decoder()
}

class MP4Decoder {
	constructor() {
		this.accum = []       // header accumulator (until moov is complete)
		this.accumLen = 0
		this.pending = null   // codec load in flight
		this.codec = null     // { feed(frames), flush(), free() }
		this.st = null        // sample-table walker: { sizes, stco, stsc, idx, ci, sInC, spc, nextOff }
		this.left = null      // unconsumed bytes
		this.fileOff = 0      // absolute file offset of left[0]
		this.skip = 0         // bytes to discard before the next sample
		this.freed = false
	}

	decode(data) {
		if (this.freed) throw Error('Decoder already freed')
		if (!data || !data.byteLength) return EMPTY
		let buf = data instanceof Uint8Array ? data : new Uint8Array(data)
		if (this.pending) return this.pending.then(() => this.decode(buf))
		if (this.st) return this.feed(buf)

		this.accum.push(buf); this.accumLen += buf.length
		let all = this.accum.length === 1 ? this.accum[0] : concat(this.accum, this.accumLen)
		let track = parseTrack(all)
		if (!track) return EMPTY // moov not complete yet
		this.accum = []; this.accumLen = 0
		return this.pending = createCodec(track).then(codec => {
			this.pending = null
			if (this.freed) { codec.free(); return EMPTY }
			this.codec = codec
			let { sizes, stco, stsc } = track
			this.st = { sizes, stco, stsc, idx: 0, ci: 0, sInC: 0, spc: spcAt(0, stsc), nextOff: stco[0] }
			this.left = all; this.fileOff = 0; this.skip = 0
			return this.extract()
		})
	}

	feed(buf) {
		if (this.skip > 0) {
			let n = Math.min(this.skip, buf.length)
			this.skip -= n; this.fileOff += n
			buf = buf.subarray(n)
			if (!buf.length) return EMPTY
		}
		this.left = append(this.left, buf)
		return this.extract()
	}

	// Walk sample tables by absolute file offset so chunk boundaries are irrelevant.
	extract() {
		let st = this.st, frames = []
		while (st.idx < st.sizes.length) {
			let off = st.nextOff, sz = st.sizes[st.idx]
			let bufOff = off - this.fileOff
			if (bufOff + sz > this.left.length) break
			if (bufOff >= 0) frames.push(this.left.subarray(bufOff, bufOff + sz))
			advance(st)
		}
		if (st.idx < st.sizes.length) {
			let nextOff = st.nextOff, end = this.fileOff + this.left.length
			if (nextOff >= end) { this.skip = nextOff - end; this.fileOff = end; this.left = null }
			else if (nextOff > this.fileOff) { this.left = this.left.subarray(nextOff - this.fileOff).slice(); this.fileOff = nextOff }
		} else this.left = null
		return frames.length ? this.codec.feed(frames) : EMPTY
	}

	flush() {
		if (this.freed) return EMPTY
		if (this.pending) return this.pending.then(() => this.flush())
		this.freed = true
		if (!this.codec) {
			if (this.accumLen && findBox(concat(this.accum, this.accumLen), 'moof')) throw Error('Fragmented MP4 is not supported')
			throw Error(this.accumLen ? 'No audio track found in MP4' : 'Not an MP4 file')
		}
		try { return this.codec.flush() } finally { this.codec.free(); this.codec = null; this.left = null }
	}

	free() {
		if (this.freed) return
		this.freed = true
		this.codec?.free(); this.codec = null
		this.accum = []; this.left = null; this.st = null
	}
}


// ===== ISO BMFF demuxer =====

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'sinf', 'wave'])

/** Walk boxes in [start, end), calling cb(type, body, bodyOff) for leaves and cb(type, null) at container boundaries. */
function walk(buf, start, end, cb) {
	let off = start
	while (off < end - 8) {
		let size = r32(buf, off)
		let type = str4(buf, off + 4)
		if (size === 0) size = end - off
		else if (size === 1 && off + 16 <= end) { size = r32(buf, off + 12); if (size < 16) break }
		else if (size < 8) break
		if (type === 'mdat') { off += size; continue }  // raw samples — read by offset later
		if (off + size > end) return false                // truncated box: wait for more data
		let body = off + 8
		if (type === 'stsd') parseStsd(buf, body, off + size, cb)
		else if (type === 'meta') walk(buf, body + 4, off + size, cb)
		else if (CONTAINERS.has(type)) { cb(type, null); walk(buf, body, off + size, cb); cb('/' + type, null) }
		else cb(type, buf.subarray(body, off + size), body)
		off += size
	}
	return true
}

function findBox(buf, name) {
	let found = false
	walk(buf, 0, buf.length, type => { if (type === name) found = true })
	return found
}

// QuickTime sound sample description: v0 = 36-byte header, v1 adds 16 bytes, v2 declares its own size.
function parseStsd(buf, off, end, cb) {
	let n = r32(buf, off + 4), pos = off + 8
	for (let i = 0; i < n && pos + 16 <= end; i++) {
		let size = r32(buf, pos), type = str4(buf, pos + 4)
		if (size < 16) break
		let ver = r16(buf, pos + 16)
		let e = { type, ver }
		if (ver === 2) {
			let dv = new DataView(buf.buffer, buf.byteOffset)
			e.sampleRate = dv.getFloat64(pos + 40)
			e.channels = r32(buf, pos + 48)
			e.bits = r32(buf, pos + 56)
			e.flags = r32(buf, pos + 60)
			e.head = r32(buf, pos + 36) || 72
		} else {
			e.channels = r16(buf, pos + 24)
			e.bits = r16(buf, pos + 26)
			e.sampleRate = r16(buf, pos + 32) // 16.16 fixed — integer part
			e.head = ver === 1 ? 52 : 36
		}
		cb('entry', e)
		if (size > e.head) walk(buf, pos + e.head, pos + size, cb)
		pos += size
	}
}

/** Parse the first audio track out of a complete moov. Returns null while moov is incomplete or absent. */
function parseTrack(buf) {
	let traks = [], t = null, moov = false
	walk(buf, 0, buf.length, (type, data, off) => {
		if (type === 'moov') moov = true
		else if (type === 'trak') traks.push(t = { children: {} })
		else if (!t) return
		else if (type === 'hdlr') t.handler = str4(data, 8)
		else if (type === 'mdhd') t.timescale = r32(data, data[0] === 1 ? 20 : 12)
		else if (type === 'entry') t.entry ??= data
		else if (type === 'stsz') t.sizes = parseStsz(data)
		else if (type === 'stco') t.stco = parseStco(data)
		else if (type === 'co64') t.stco = parseCo64(data)
		else if (type === 'stsc') t.stsc = parseStsc(data)
		else if (data) t.children[type] ??= data
	})
	if (!moov) return null
	let track = traks.find(t => t.handler === 'soun' && t.entry) ?? traks.find(t => t.entry && AUDIO_TYPES.has(t.entry.type))
	if (!track) throw Error('No audio track found in MP4')
	if (!track.sizes || !track.stco?.length) throw Error('Audio track has no sample tables')
	if (!track.entry.sampleRate && track.timescale) track.entry.sampleRate = track.timescale
	return track
}

const AUDIO_TYPES = new Set(['mp4a', 'alac', '.mp3', 'fLaC', 'Opus', 'sowt', 'twos', 'in24', 'in32', 'fl32', 'fl64', 'lpcm', 'ipcm', 'fpcm', 'raw ', 'NONE', 'ulaw', 'alaw', 'samr', 'sawb', 'ac-3', 'ec-3'])

/** esds → { oti, dsi } (objectTypeIndication + DecoderSpecificInfo) */
function parseEsds(data) {
	let off = 4, oti = 0
	while (off < data.length - 2) {
		let tag = data[off++], len = 0, b
		do { b = data[off++]; len = (len << 7) | (b & 0x7f) } while (b & 0x80 && off < data.length)
		if (tag === 0x03) off += 3
		else if (tag === 0x04) { oti = data[off]; off += 13 }
		else if (tag === 0x05) return { oti, dsi: data.subarray(off, off + len) }
		else off += len
	}
	return { oti, dsi: null }
}

function parseStsz(d) {
	let sz = r32(d, 4), n = r32(d, 8)
	if (sz) return new Array(n).fill(sz)
	let sizes = new Array(n)
	for (let i = 0; i < n; i++) sizes[i] = r32(d, 12 + i * 4)
	return sizes
}
function parseStco(d) { let n = r32(d, 4), o = new Array(n); for (let i = 0; i < n; i++) o[i] = r32(d, 8 + i * 4); return o }
function parseCo64(d) { let n = r32(d, 4), o = new Array(n); for (let i = 0; i < n; i++) o[i] = r32(d, 8 + i * 8) * 0x100000000 + r32(d, 12 + i * 8); return o }
function parseStsc(d) { let n = r32(d, 4), e = new Array(n); for (let i = 0; i < n; i++) e[i] = { first: r32(d, 8 + i * 12), spc: r32(d, 12 + i * 12) }; return e }

function spcAt(ci, stsc) {
	if (!stsc?.length) return 1
	let spc = 1, cn = ci + 1
	for (let j = stsc.length - 1; j >= 0; j--) if (cn >= stsc[j].first) { spc = stsc[j].spc; break }
	return spc
}

function advance(st) {
	st.nextOff += st.sizes[st.idx]
	st.idx++; st.sInC++
	if (st.sInC >= st.spc && st.ci + 1 < st.stco.length) {
		st.ci++; st.sInC = 0
		st.spc = spcAt(st.ci, st.stsc)
		st.nextOff = st.stco[st.ci]
	}
}


// ===== codec routing =====

const MP3_OTI = new Set([0x69, 0x6B]), AAC_OTI = new Set([0x40, 0x66, 0x67, 0x68])
const UNSUPPORTED = { 0xE1: 'QCELP' }
const DTS_TYPES = new Set(['dtsc', 'dtsh', 'dtsl', 'dtse']) // DTS-HD variants carry a decodable core

async function createCodec({ entry, children }) {
	let { type } = entry
	if (type === 'mp4a') {
		let { oti, dsi } = children.esds ? parseEsds(children.esds) : {}
		if (MP3_OTI.has(oti)) return frames(import('@audio/decode-mp3'))
		if (oti === 0xA5) return frames(import('@audio/decode-ac3'))
		if (oti === 0xA9) return frames(import('@audio/decode-dts'))
		if (oti === 0xA6) return frames(import('@audio/decode-eac3'))
		if (!oti || AAC_OTI.has(oti)) {
			if (!dsi) throw Error('MP4 AAC track has no AudioSpecificConfig')
			return aac({ asc: dsi })
		}
		throw unsupported(UNSUPPORTED[oti] || 'esds object type 0x' + oti.toString(16))
	}
	if (type === 'alac') {
		if (!children.alac) throw Error('MP4 ALAC track has no magic cookie')
		return aac({ alac: children.alac })
	}
	if (type === '.mp3') return frames(import('@audio/decode-mp3'))
	if (type === 'fLaC') {
		if (!children.dfLa) throw Error('MP4 FLAC track has no dfLa box')
		return flac(children.dfLa.subarray(4))
	}
	if (type === 'Opus') {
		if (!children.dOps) throw Error('MP4 Opus track has no dOps box')
		return opus(children.dOps)
	}
	if (type === 'samr' || type === 'sawb') return amr(type === 'sawb')
	if (type === 'ac-3') return frames(import('@audio/decode-ac3'))
	if (type === 'ec-3') return frames(import('@audio/decode-eac3'))
	if (DTS_TYPES.has(type)) return frames(import('@audio/decode-dts'))
	let fmt = pcmFormat(entry, children)
	if (fmt) return pcm(fmt)
	throw unsupported(UNSUPPORTED[type] || type)
}

function unsupported(name) { return Error('Unsupported MP4 audio codec: ' + name) }

function pcmFormat(e, ch) {
	let { type, channels, bits, sampleRate } = e
	let f = { channels, sampleRate, bits, float: false, be: false, signed: true }
	let enda = ch.enda ? r16(ch.enda, 0) === 1 : null // QuickTime endianness flag: 1 = little
	switch (type) {
		case 'sowt': f.bits = bits || 16; break
		case 'twos': f.bits = bits || 16; f.be = true; break
		case 'in24': f.bits = 24; f.be = !enda; break
		case 'in32': f.bits = 32; f.be = !enda; break
		case 'fl32': f.bits = 32; f.float = true; f.be = !enda; break
		case 'fl64': f.bits = 64; f.float = true; f.be = !enda; break
		case 'raw ': case 'NONE': f.bits = bits || 8; f.signed = f.bits > 8; break
		case 'ulaw': f.bits = 8; f.law = 'u'; break
		case 'alaw': f.bits = 8; f.law = 'a'; break
		case 'lpcm': f.float = !!(e.flags & 1); f.be = !!(e.flags & 2); f.signed = !!(e.flags & 4) || f.float; break
		case 'ipcm': case 'fpcm': {
			let c = ch.pcmC
			if (!c) return null
			f.float = type === 'fpcm'; f.be = !(c[4] & 1); f.bits = c[5]
			break
		}
		default: return null
	}
	if (!f.channels || !f.sampleRate || !f.bits) return null
	return f
}

// --- adapters: { feed(frames: Uint8Array[]), flush(), free() } ---

async function aac(opts) {
	let dec = await (await import('@audio/decode-aac')).decoder(opts)
	return { feed: frames => dec.decode(frames), flush: () => dec.flush(), free: () => dec.free() }
}

// self-synchronizing frame streams (MP3, AC-3, DTS): the codec resyncs on concatenated samples
async function frames(load) {
	let dec = await (await load).decoder()
	return { feed: frames => dec.decode(concat(frames)), flush: () => dec.flush?.() ?? EMPTY, free: () => dec.free() }
}

async function flac(blocks) {
	let dec = await (await import('@audio/decode-flac')).decoder()
	let head = concat([new Uint8Array([0x66, 0x4C, 0x61, 0x43]), blocks]) // "fLaC" + METADATA_BLOCKs
	let started = false
	return {
		feed: frames => { let bytes = concat(frames); if (!started) { started = true; bytes = concat([head, bytes]) } return dec.decode(bytes) },
		flush: () => started ? dec.flush() : EMPTY,
		free: () => dec.free()
	}
}

async function opus(dOps) {
	let channels = dOps[1]
	let opts = { channels, sampleRate: 48000, preSkip: r16(dOps, 2), outputGain: (r16(dOps, 8) << 16) >> 16 }
	if (dOps[10] > 0) {
		opts.streamCount = dOps[11]; opts.coupledStreamCount = dOps[12]
		opts.channelMappingTable = Array.from(dOps.subarray(13, 13 + channels))
	}
	let dec = await (await import('@audio/decode-opus/core')).createOpusDecoder()
	dec.configure(opts)
	return {
		feed: frames => {
			let r = dec.decodeFrames(frames)
			if (!r.samplesDecoded) return EMPTY
			return { channelData: r.channelData.map(c => c.subarray(0, r.samplesDecoded)), sampleRate: r.sampleRate }
		},
		flush: () => EMPTY,
		free: () => dec.free()
	}
}

async function amr(wb) {
	let dec = await (await import('@audio/decode-amr')).decoder()
	let magic = new TextEncoder().encode(wb ? '#!AMR-WB\n' : '#!AMR\n'), started = false
	return {
		feed: frames => { let bytes = concat(frames); if (!started) { started = true; bytes = concat([magic, bytes]) } return dec.decode(bytes) },
		flush: () => dec.flush?.() ?? EMPTY,
		free: () => dec.free()
	}
}

// interleaved PCM → planar float. Keeps a partial frame between calls.
function pcm({ channels, sampleRate, bits, float, be, signed, law }) {
	let bps = bits >> 3, frame = bps * channels, left = null
	let read = law === 'u' ? ulaw : law === 'a' ? alaw : reader(bits, float, be, signed)
	return {
		feed(frames) {
			let buf = concat(left ? [left, ...frames] : frames)
			let n = Math.floor(buf.length / frame)
			left = n * frame < buf.length ? buf.slice(n * frame) : null
			if (!n) return EMPTY
			let dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
			let channelData = Array.from({ length: channels }, () => new Float32Array(n))
			for (let i = 0, off = 0; i < n; i++)
				for (let c = 0; c < channels; c++, off += bps) channelData[c][i] = read(dv, off)
			return { channelData, sampleRate }
		},
		flush: () => EMPTY,
		free() { left = null }
	}
}

function reader(bits, float, be, signed) {
	let le = !be
	if (float) return bits === 64 ? (dv, o) => dv.getFloat64(o, le) : (dv, o) => dv.getFloat32(o, le)
	switch (bits) {
		case 8: return signed ? (dv, o) => dv.getInt8(o) / 128 : (dv, o) => (dv.getUint8(o) - 128) / 128
		case 16: return (dv, o) => dv.getInt16(o, le) / 32768
		case 24: return be
			? (dv, o) => ((dv.getUint8(o) << 24 | dv.getUint8(o + 1) << 16 | dv.getUint8(o + 2) << 8) >> 8) / 8388608
			: (dv, o) => ((dv.getUint8(o + 2) << 24 | dv.getUint8(o + 1) << 16 | dv.getUint8(o) << 8) >> 8) / 8388608
		case 32: return (dv, o) => dv.getInt32(o, le) / 2147483648
	}
	throw Error('Unsupported PCM bit depth: ' + bits)
}

// ITU-T G.711
function ulaw(dv, o) {
	let u = ~dv.getUint8(o) & 0xFF
	let t = (((u & 0x0F) << 3) + 0x84) << ((u & 0x70) >> 4)
	return ((u & 0x80) ? 0x84 - t : t - 0x84) / 32768
}
function alaw(dv, o) {
	let a = dv.getUint8(o) ^ 0x55
	let t = (a & 0x0F) << 4, seg = (a & 0x70) >> 4
	t = seg === 0 ? t + 8 : seg === 1 ? t + 0x108 : (t + 0x108) << (seg - 1)
	return ((a & 0x80) ? t : -t) / 32768
}


// ===== helpers =====

function r32(b, o) { return (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0 }
function r16(b, o) { return b[o] << 8 | b[o + 1] }
function str4(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) }

function append(left, buf) {
	if (!left?.length) return buf.slice()
	let out = new Uint8Array(left.length + buf.length)
	out.set(left); out.set(buf, left.length)
	return out
}

function concat(parts, total) {
	if (parts.length === 1) return parts[0]
	if (total == null) { total = 0; for (let p of parts) total += p.length }
	let out = new Uint8Array(total), off = 0
	for (let p of parts) { out.set(p, off); off += p.length }
	return out
}

function merge(a, b) {
	if (!b?.channelData?.length) return a
	if (!a?.channelData?.length) return b
	return {
		channelData: a.channelData.map((ch, i) => {
			let m = new Float32Array(ch.length + b.channelData[i].length)
			m.set(ch); m.set(b.channelData[i], ch.length)
			return m
		}),
		sampleRate: a.sampleRate
	}
}
