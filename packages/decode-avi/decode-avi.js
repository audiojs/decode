/**
 * AVI audio decoder — RIFF/AVI demuxer (incl. OpenDML AVIX) that routes the audio stream to a codec:
 * PCM / µ-law / A-law inline · MP3 → @audio/decode-mp3 · AAC → @audio/decode-aac · AC-3 → @audio/decode-ac3 · DTS → @audio/decode-dts.
 *
 * let { channelData, sampleRate } = await decode(avibuf)
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
	let dec = new AVIDecoder()
	try {
		let result = await dec.decode(buf)
		return merge(result, await dec.flush())
	} finally { dec.free() }
}

/**
 * Create streaming decoder instance. decode() is synchronous once the stream headers (hdrl) have
 * been seen; the call that completes them returns a Promise while the codec module loads.
 */
export async function decoder() {
	return new AVIDecoder()
}

class AVIDecoder {
	constructor() {
		this.left = null
		this.pending = null
		this.codec = null
		this.stream = null     // { index, id: 'NNwb', fmt }
		this.streams = 0       // strl lists seen
		this.header = false    // hdrl complete
		this.frames = []       // audio chunks queued while the codec loads
		this.freed = false
		this.started = false
	}

	decode(data) {
		if (this.freed) throw Error('Decoder already freed')
		if (!data || !data.byteLength) return EMPTY
		let buf = data instanceof Uint8Array ? data : new Uint8Array(data)
		if (this.pending) return this.pending.then(() => this.decode(buf))
		buf = append(this.left, buf); this.left = null
		if (!this.started) {
			if (buf.length < 12) { this.left = buf; return EMPTY }
			if (str4(buf, 0) !== 'RIFF' || str4(buf, 8) !== 'AVI ') throw Error('Not an AVI file')
			this.started = true
		}
		let frames = this.scan(buf)
		if (this.codec) return frames.length ? this.codec.feed(frames) : EMPTY
		this.frames.push(...frames)
		if (!this.header) return EMPTY
		if (!this.stream) throw Error('No audio stream found in AVI')
		return this.pending = createCodec(this.stream.fmt).then(codec => {
			this.pending = null
			if (this.freed) { codec.free(); return EMPTY }
			this.codec = codec
			let queued = this.frames; this.frames = []
			return queued.length ? codec.feed(queued) : EMPTY
		})
	}

	// Chunk scanner: descends into RIFF/LIST containers, harvests the audio stream's chunks, keeps the tail.
	scan(buf) {
		let frames = [], pos = 0
		while (pos + 8 <= buf.length) {
			let id = str4(buf, pos), size = r32(buf, pos + 4)
			if (id === 'RIFF' || id === 'LIST') {
				if (pos + 12 > buf.length) break
				let type = str4(buf, pos + 8)
				if (type === 'strl') this.streams++
				if (type === 'hdrl' || type === 'strl' || type === 'movi' || type === 'rec ' || id === 'RIFF') { pos += 12; continue } // descend
				pos += 8 + size + (size & 1)
				continue
			}
			let end = pos + 8 + size + (size & 1)
			if (end > buf.length) {
				if (this.stream && id === this.stream.id) break            // partial audio chunk — wait
				if (!this.header && (id === 'strh' || id === 'strf')) break // partial header
				if (size > 0x10000000) throw Error('Corrupt AVI chunk')
				break
			}
			let body = buf.subarray(pos + 8, pos + 8 + size)
			if (!this.header) {
				if (id === 'strh' && !this.stream && str4(body, 0) === 'auds') this.stream = { index: this.streams - 1, id: null, fmt: null }
				else if (id === 'strf' && this.stream && this.stream.index === this.streams - 1 && !this.stream.fmt) {
					this.stream.fmt = parseWaveFormat(body)
					this.stream.id = String(this.stream.index).padStart(2, '0') + 'wb'
				}
				else if (id === 'avih') {}
				else if (id !== 'strn' && id !== 'strd' && id !== 'indx' && id !== 'vprp' && id !== 'JUNK' && id !== 'odml' && id !== 'dmlh' && id !== 'ISFT' && this.streams && (id.endsWith('wb') || id.endsWith('dc') || id.endsWith('db') || id === 'idx1')) this.header = true
			}
			if (this.stream?.id && id === this.stream.id && size) { frames.push(body.slice()); this.header = true }
			pos = end
		}
		if (pos < buf.length) this.left = buf.subarray(pos).slice()
		return frames
	}

	flush() {
		if (this.freed) return EMPTY
		if (this.pending) return this.pending.then(() => this.flush())
		this.freed = true
		if (!this.codec) throw Error(this.started ? 'No audio stream found in AVI' : 'Not an AVI file')
		try { return this.codec.flush() } finally { this.codec.free(); this.codec = null; this.left = null }
	}

	free() {
		if (this.freed) return
		this.freed = true
		this.codec?.free(); this.codec = null
		this.left = null; this.frames = []
	}
}

/** WAVEFORMATEX(TENSIBLE) → { tag, channels, sampleRate, bits, extra } */
function parseWaveFormat(b) {
	let dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
	let f = { tag: dv.getUint16(0, true), channels: dv.getUint16(2, true), sampleRate: dv.getUint32(4, true), bits: dv.getUint16(14, true), extra: null }
	let cb = b.length >= 18 ? dv.getUint16(16, true) : 0
	if (f.tag === 0xFFFE && b.length >= 40) { f.tag = dv.getUint16(24, true); f.bits = dv.getUint16(18, true) || f.bits; f.extra = b.subarray(40, 18 + cb) }
	else if (cb) f.extra = b.subarray(18, 18 + cb)
	return f
}

const NAMES = { 0x160: 'WMA v1', 0x161: 'WMA v2', 0x162: 'WMA Pro', 0x163: 'WMA Lossless', 0x50: 'MPEG-1 Layer II', 0x2: 'MS ADPCM', 0x11: 'IMA ADPCM', 0x22: 'TrueSpeech', 0x31: 'GSM 6.10', 0x8000: 'AAC' }

async function createCodec(fmt) {
	switch (fmt.tag) {
		case 1: return pcm({ ...fmt, float: false, signed: fmt.bits > 8 })
		case 3: return pcm({ ...fmt, float: true, signed: true })
		case 6: return pcm({ ...fmt, bits: 8, law: 'a' })
		case 7: return pcm({ ...fmt, bits: 8, law: 'u' })
		case 0x55: return frames(import('@audio/decode-mp3'))
		case 0x2000: return frames(import('@audio/decode-ac3'))
		case 0x2001: return frames(import('@audio/decode-dts'))
		case 0xFF: {
			if (!fmt.extra?.length) throw Error('AVI AAC stream has no AudioSpecificConfig')
			let dec = await (await import('@audio/decode-aac')).decoder({ asc: fmt.extra })
			return { feed: frames => dec.decode(frames), flush: () => dec.flush(), free: () => dec.free() }
		}
	}
	throw Error('Unsupported AVI audio codec: ' + (NAMES[fmt.tag] || 'wFormatTag 0x' + fmt.tag.toString(16)))
}

// self-synchronizing frame streams (MP3, AC-3, DTS): the codec resyncs on concatenated chunks
async function frames(load) {
	let dec = await (await load).decoder()
	return { feed: frames => dec.decode(concat(frames)), flush: () => dec.flush?.() ?? EMPTY, free: () => dec.free() }
}

// interleaved little-endian PCM → planar float. Keeps a partial frame between calls.
function pcm({ channels, sampleRate, bits, float, signed, law }) {
	if (!channels || !sampleRate || !bits) throw Error('Invalid AVI PCM format')
	let bps = bits >> 3, frame = bps * channels, left = null
	let read = law === 'u' ? ulaw : law === 'a' ? alaw : reader(bits, float, signed)
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

function reader(bits, float, signed) {
	if (float) return bits === 64 ? (dv, o) => dv.getFloat64(o, true) : (dv, o) => dv.getFloat32(o, true)
	switch (bits) {
		case 8: return signed ? (dv, o) => dv.getInt8(o) / 128 : (dv, o) => (dv.getUint8(o) - 128) / 128
		case 16: return (dv, o) => dv.getInt16(o, true) / 32768
		case 24: return (dv, o) => ((dv.getUint8(o + 2) << 24 | dv.getUint8(o + 1) << 16 | dv.getUint8(o) << 8) >> 8) / 8388608
		case 32: return (dv, o) => dv.getInt32(o, true) / 2147483648
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

function r32(b, o) { return (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0 } // RIFF is little-endian
function str4(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) }

function append(left, buf) {
	if (!left?.length) return buf
	let out = new Uint8Array(left.length + buf.length)
	out.set(left); out.set(buf, left.length)
	return out
}

function concat(parts) {
	if (parts.length === 1) return parts[0]
	let total = 0
	for (let p of parts) total += p.length
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
