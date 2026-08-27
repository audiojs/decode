/**
 * WebM / Matroska audio decoder — Opus, Vorbis, AAC, MP3, FLAC, ALAC, PCM, AC-3, DTS
 * Opus and Vorbis (the WebM codecs) are bundled and decode synchronously; the Matroska-only codecs
 * load their package on the chunk that completes the track header, where decode() returns a Promise.
 *
 * let { channelData, sampleRate } = await decode(webmbuf)
 * let dec = await decoder(); let result = dec.decode(chunk)
 */

import { createOpusDecoder } from '@audio/decode-opus/core'
import { decoder as createVorbisDecoder } from '@audio/decode-vorbis'

const EMPTY = Object.freeze({ channelData: [], sampleRate: 0 })

// EBML element IDs
const ID_EBML = 0x1A45DFA3
const ID_SEGMENT = 0x18538067
const ID_TRACKS = 0x1654AE6B
const ID_TRACK_ENTRY = 0xAE
const ID_TRACK_NUMBER = 0xD7
const ID_TRACK_TYPE = 0x83
const ID_CODEC_ID = 0x86
const ID_CODEC_PRIVATE = 0x63A2
const ID_AUDIO = 0xE1
const ID_SAMPLE_RATE = 0xB5
const ID_CHANNELS = 0x9F
const ID_BIT_DEPTH = 0x6264
const ID_CODEC_DELAY = 0x56AA
const ID_SEEK_PRE_ROLL = 0x56BB
const ID_CLUSTER = 0x1F43B675
const ID_SIMPLE_BLOCK = 0xA3
const ID_BLOCK_GROUP = 0xA0
const ID_BLOCK = 0xA1
const ID_DISCARD_PADDING = 0x75A2

// Master elements whose children we descend into
const MASTER = new Set([
	ID_EBML, ID_SEGMENT, ID_TRACKS, ID_AUDIO,
	ID_CLUSTER, ID_BLOCK_GROUP
])

// Unknown-size sentinel values per VINT length (all value bits = 1)
const UNKNOWN_SIZE = [0x7F, 0x3FFF, 0x1FFFFF, 0x0FFFFFFF, 0x07FFFFFFFF, 0x03FFFFFFFFFF, 0x01FFFFFFFFFFFF, 0x00FFFFFFFFFFFFFF]

/**
 * Read EBML element ID (VINT with leading 1 retained)
 */
function readId(b, o) {
	if (o >= b.length) return null
	let first = b[o], len = 1, mask = 0x80
	while (len <= 4 && !(first & mask)) { len++; mask >>= 1 }
	if (len > 4) return null
	let val = first
	for (let i = 1; i < len; i++) {
		if (o + i >= b.length) return null
		val = val * 256 + b[o + i]
	}
	return { val, len }
}

/**
 * Read EBML VINT data size (leading 1 masked off)
 * Returns -1 for unknown size
 */
function readSize(b, o) {
	if (o >= b.length) return null
	let first = b[o], len = 1, mask = 0x80
	while (len <= 8 && !(first & mask)) { len++; mask >>= 1 }
	if (len > 8) return null
	let val = first & (mask - 1)
	for (let i = 1; i < len; i++) {
		if (o + i >= b.length) return null
		val = val * 256 + b[o + i]
	}
	if (val === UNKNOWN_SIZE[len - 1]) return { val: -1, len }
	return { val, len }
}

function readUint(b, o, n) {
	let v = 0
	for (let i = 0; i < n; i++) v = v * 256 + b[o + i]
	return v
}

function readSint(b, o, n) {
	if (!n) return 0
	let v = b[o] & 0x80 ? -1 : 0
	for (let i = 0; i < n; i++) v = v * 256 + b[o + i]
	return v
}

function readFloat(b, o, n) {
	let dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
	if (n === 4) return dv.getFloat32(o)
	if (n === 8) return dv.getFloat64(o)
	return 0
}

function readStr(b, o, n) {
	let s = ''
	for (let i = 0; i < n; i++) {
		if (b[o + i] === 0) break
		s += String.fromCharCode(b[o + i])
	}
	return s
}

/**
 * Parse Opus identification header (CodecPrivate in WebM)
 * RFC 7845: "OpusHead" + version + channels + preSkip(LE16) + sampleRate(LE32) + outputGain(LE16) + mappingFamily...
 */
function parseOpusHead(d) {
	if (!d || d.length < 19) return null
	if (readStr(d, 0, 8) !== 'OpusHead') return null
	if (d[8] > 15) return null // unknown major version

	let channels = d[9]
	if (!channels) return null
	let preSkip = d[10] | (d[11] << 8)
	let sampleRate = d[12] | (d[13] << 8) | (d[14] << 16) | (d[15] << 24)
	let outputGain = (d[16] | (d[17] << 8)) << 16 >> 16
	let mappingFamily = d[18]
	if (mappingFamily === 0 && channels > 2) return null
	let streamCount = 1, coupledStreamCount = channels > 1 ? 1 : 0
	let channelMappingTable = channels === 1 ? [0] : [0, 1]

	if (mappingFamily > 0) {
		if (d.length < 21 + channels) return null
		streamCount = d[19]
		coupledStreamCount = d[20]
		channelMappingTable = Array.from(d.subarray(21, 21 + channels))
	}

	return { channels, preSkip, sampleRate, outputGain, mappingFamily, streamCount, coupledStreamCount, channelMappingTable }
}

/** Parse the first WebM audio track. */
function parseWebm(buf) {
	let b = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
	if (b.length < 4) throw Error('Not a WebM file')

	let id = readId(b, 0)
	if (!id || id.val !== ID_EBML) throw Error('Not a WebM file')

	let curEntry = null
	let audioTrack = null

	function walk(start, end) {
		let pos = start
		while (pos < end) {
			let eid = readId(b, pos)
			if (!eid) break
			let siz = readSize(b, pos + eid.len)
			if (!siz) break

			let dataOff = pos + eid.len + siz.len
			let dataLen = siz.val
			let complete = dataLen >= 0 && dataOff + dataLen <= end
			let elemEnd = dataLen < 0 ? end : Math.min(dataOff + dataLen, end)
			if (dataOff > end) break

			let elemId = eid.val

			if (elemId === ID_TRACK_ENTRY) {
				// Start a new track entry, then descend
				curEntry = { number: 0, type: 0, codec: '', sampleRate: 48000, channels: 2, bitDepth: 0, codecPrivate: null, codecDelay: 0, seekPreRoll: 0 }
				walk(dataOff, elemEnd)
				if (!audioTrack && curEntry.type === 2 && curEntry.codec) audioTrack = curEntry
				curEntry = null
			} else if (elemId === ID_CLUSTER) {
				// Track metadata precedes media clusters.
			} else if (MASTER.has(elemId)) {
				walk(dataOff, elemEnd)
			} else if (curEntry && complete) {
				// Inside a TrackEntry
				if (elemId === ID_TRACK_NUMBER) curEntry.number = readUint(b, dataOff, dataLen)
				else if (elemId === ID_TRACK_TYPE) curEntry.type = readUint(b, dataOff, dataLen)
				else if (elemId === ID_CODEC_ID) curEntry.codec = readStr(b, dataOff, dataLen)
				else if (elemId === ID_CODEC_PRIVATE) curEntry.codecPrivate = b.slice(dataOff, dataOff + dataLen)
				else if (elemId === ID_SAMPLE_RATE && dataLen > 0) curEntry.sampleRate = readFloat(b, dataOff, dataLen)
				else if (elemId === ID_CHANNELS && dataLen > 0) curEntry.channels = readUint(b, dataOff, dataLen)
				else if (elemId === ID_BIT_DEPTH && dataLen > 0) curEntry.bitDepth = readUint(b, dataOff, dataLen)
				else if (elemId === ID_CODEC_DELAY && dataLen > 0) curEntry.codecDelay = readUint(b, dataOff, dataLen)
				else if (elemId === ID_SEEK_PRE_ROLL && dataLen > 0) curEntry.seekPreRoll = readUint(b, dataOff, dataLen)
			}

			pos = elemEnd
		}
	}

	walk(0, b.length)

	if (!audioTrack) throw Error('No audio track found in WebM')

	return {
		codec: audioTrack.codec,
		trackNum: audioTrack.number,
		sampleRate: audioTrack.sampleRate,
		channels: audioTrack.channels,
		bitDepth: audioTrack.bitDepth,
		codecPrivate: audioTrack.codecPrivate,
		codecDelay: audioTrack.codecDelay,
		seekPreRoll: audioTrack.seekPreRoll
	}
}

/**
 * Parse Matroska Vorbis CodecPrivate into 3 header packets.
 * Format: byte 0 = num_packets-1 (2), then Xiph lacing sizes, then concatenated packets.
 */
function parseVorbisPrivate(d) {
	if (!d || d.length < 3 || d[0] !== 2) return null
	let pos = 1, sizes = []
	for (let i = 0; i < 2; i++) {
		let sz = 0
		while (pos < d.length && d[pos] === 255) { sz += 255; pos++ }
		if (pos < d.length) { sz += d[pos]; pos++ }
		sizes.push(sz)
	}
	let h2Start = pos + sizes[0], h3Start = h2Start + sizes[1]
	if (h3Start >= d.length) return null
	let h1 = d.slice(pos, h2Start)
	let h2 = d.slice(h2Start, h3Start)
	let h3 = d.slice(h3Start)
	let vorbis = header => header[1] === 0x76 && header[2] === 0x6f && header[3] === 0x72 && header[4] === 0x62 && header[5] === 0x69 && header[6] === 0x73
	if (h1.length < 30 || h2.length < 7 || h3.length < 7 || h1[0] !== 1 || h2[0] !== 3 || h3[0] !== 5 || !vorbis(h1) || !vorbis(h2) || !vorbis(h3)) return null
	return [h1, h2, h3]
}

// OGG CRC lookup table (polynomial 0x04C11DB7)
const OGG_CRC = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
	let r = i << 24
	for (let j = 0; j < 8; j++) r = (r << 1) ^ ((r >>> 31) * 0x04C11DB7)
	OGG_CRC[i] = r >>> 0
}
function oggCrc(buf) {
	let c = 0
	for (let i = 0; i < buf.length; i++) c = ((c << 8) ^ OGG_CRC[((c >>> 24) ^ buf[i]) & 0xFF]) >>> 0
	return c
}

/**
 * Build a single OGG page from complete packets.
 */
function makeOggPage(packets, granule, serial, seq, flags) {
	// Build segment table: each packet uses ceil(len/255) segments for 255-byte chunks + 1 terminating segment
	let segs = []
	for (let p of packets) {
		let len = p.length
		while (len >= 255) { segs.push(255); len -= 255 }
		segs.push(len) // terminating segment (0 if packet is exact multiple of 255)
	}

	let bodyLen = 0
	for (let p of packets) bodyLen += p.length
	let headerLen = 27 + segs.length
	let page = new Uint8Array(headerLen + bodyLen)
	let dv = new DataView(page.buffer)

	page[0] = 0x4F; page[1] = 0x67; page[2] = 0x67; page[3] = 0x53 // "OggS"
	page[4] = 0 // version
	page[5] = flags
	// Granule position (64-bit LE); -1 = not set (0xFFFFFFFFFFFFFFFF)
	if (granule < 0) { dv.setUint32(6, 0xFFFFFFFF, true); dv.setUint32(10, 0xFFFFFFFF, true) }
	else { dv.setUint32(6, granule >>> 0, true); dv.setUint32(10, (granule / 0x100000000) >>> 0, true) }
	dv.setUint32(14, serial, true)
	dv.setUint32(18, seq, true)
	dv.setUint32(22, 0, true) // CRC placeholder
	page[26] = segs.length
	for (let i = 0; i < segs.length; i++) page[27 + i] = segs[i]
	let off = headerLen
	for (let p of packets) { page.set(p, off); off += p.length }
	dv.setUint32(22, oggCrc(page), true)

	return page
}

/**
 * Wrap raw Vorbis frames in Ogg pages for incremental decoding.
 * A granule position of -1 leaves sample counting to the decoder.
 */
function framesToOgg(frames, serial, seqRef) {
	let pages = [], i = 0
	while (i < frames.length) {
		let pkt = [], segCount = 0
		while (i < frames.length) {
			let needed = Math.floor(frames[i].length / 255) + 1
			if (segCount + needed > 255) break
			pkt.push(frames[i])
			segCount += needed
			i++
		}
		pages.push(makeOggPage(pkt, -1, serial, seqRef.n++, 0))
	}
	let totalLen = 0
	for (let p of pages) totalLen += p.length
	return concat(pages, totalLen)
}

/** Initialize Vorbis from WebM CodecPrivate headers. */
function createVorbisStream(headers, dec) {
	let serial = 0x564F5242, seq = { n: 0 }
	// Feed header pages: BOS (identification) + comment/setup
	let bos = makeOggPage([headers[0]], 0, serial, seq.n++, 0x02)
	let hdr = makeOggPage([headers[1], headers[2]], 0, serial, seq.n++, 0)
	dec.decode(concat([bos, hdr], bos.length + hdr.length))

	return { dec, serial, seq }
}

/**
 * Whole-file decode
 * @param {Uint8Array|ArrayBuffer} src
 * @returns {Promise<{channelData: Float32Array[], sampleRate: number}>}
 */
export default async function decode(src) {
	if (!src || typeof src === 'string' || !(src.buffer || src.byteLength != null || src.length))
		throw TypeError('Expected ArrayBuffer or Uint8Array')
	let buf = src instanceof Uint8Array ? src : new Uint8Array(src.buffer || src)
	if (!buf.length) throw Error('Not a WebM file')
	parseWebm(buf) // validate before streaming
	let dec = await decoder()
	try {
		let result = await dec.decode(buf)
		let flushed = await dec.flush()
		return merge(result, flushed)
	} finally {
		dec.free()
	}
}

/**
 * Create streaming decoder instance
 * @returns {Promise<{decode(chunk: Uint8Array): AudioData | Promise<AudioData>, flush(): AudioData, free(): void}>}
 */
export async function decoder() {
	let prepared = await Promise.allSettled([createOpusDecoder(), createVorbisDecoder()])
	let failed = prepared.find(result => result.status === 'rejected')
	if (failed) {
		for (let result of prepared) if (result.status === 'fulfilled') result.value.free()
		throw failed.reason
	}
	let [opus, vorbis] = prepared.map(result => result.value)
	let freed = false
	let codec = null, info = null, pending = null
	let accum = [], accumLen = 0 // header parsing accumulator
	let scanner = null

	let freePrepared = () => {
		opus?.free(); opus = null
		vorbis?.free(); vorbis = null
	}

	let start = (adapter, buf) => {
		codec = adapter
		scanner = new EBMLScanner(info.trackNum)
		let frames = scanner.feed(buf)
		accum = []; accumLen = 0
		return frames.length ? codec.feed(frames) : EMPTY
	}

	return {
		decode(data) {
			if (freed) throw Error('Decoder already freed')
			if (!data) return EMPTY
			let chunk = data instanceof Uint8Array ? data : new Uint8Array(data)
			if (!chunk.length) return EMPTY
			if (pending) return pending.then(() => this.decode(chunk))

			// Phase 2: incremental scanning
			if (codec) {
				let frames = scanner.feed(chunk)
				return frames.length ? codec.feed(frames) : EMPTY
			}

			// Phase 1: parse header to get track info
			accum.push(chunk)
			accumLen += chunk.length
			let buf = accum.length === 1 ? accum[0] : concat(accum, accumLen)
			try { info = parseWebm(buf) } catch {
				if (accumLen < 8192) return EMPTY
				throw Error('Not a WebM file')
			}

			if (info.codec === 'A_VORBIS') {
				if (!info.codecPrivate && accumLen < 8192) { info = null; return EMPTY }
				let headers = parseVorbisPrivate(info.codecPrivate)
				if (!headers) throw Error('Invalid Vorbis CodecPrivate')
				opus.free(); opus = null
				let v = vorbis; vorbis = null
				return start(vorbisAdapter(createVorbisStream(headers, v)), buf)
			}
			if (info.codec === 'A_OPUS') {
				if (!info.codecPrivate && accumLen < 8192) { info = null; return EMPTY }
				let head = parseOpusHead(info.codecPrivate)
				if (!head) throw Error('Invalid Opus CodecPrivate')
				vorbis.free(); vorbis = null
				let o = opus; opus = null
				return start(opusAdapter(createOpusStream(info, head, o)), buf)
			}

			// Matroska-only codecs: release the bundled runtimes, load the codec package
			freePrepared()
			return pending = createMatroskaCodec(info).then(adapter => {
				pending = null
				if (freed) { adapter.free(); return EMPTY }
				return start(adapter, buf)
			})
		},
		flush() {
			if (freed) return EMPTY
			if (pending) return pending.then(() => this.flush())
			freed = true; scanner = null
			if (codec) {
				try { return codec.flush() }
				finally { codec.free(); codec = null }
			}
			freePrepared()
			if (accumLen) throw Error(info ? 'Unsupported WebM codec: ' + info.codec : 'Not a WebM file')
			return EMPTY
		},
		free() {
			if (freed) return
			freed = true
			if (codec) { codec.free(); codec = null }
			else freePrepared()
			scanner = null
		}
	}
}

// --- codec adapters: { feed(frames: Uint8Array[]) → AudioData, flush() → AudioData, free() } ---

function opusAdapter({ dec }) {
	return {
		feed(frames) {
			if (!frames.discard) return normResult(dec.decodeFrames(frames))
			let parts = []
			frames.forEach((frame, i) => {
				let r = normResult(dec.decodeFrames([frame]))
				let drop = frames.discard.get(i)
				if (drop && r.channelData.length) r = { channelData: r.channelData.map(ch => ch.subarray(0, Math.max(0, ch.length - drop))), sampleRate: r.sampleRate }
				if (r.channelData[0]?.length) parts.push(r)
			})
			return parts.reduce(merge, EMPTY)
		},
		flush: () => EMPTY,
		free: () => dec.free()
	}
}

function vorbisAdapter({ dec, serial, seq }) {
	return {
		feed: frames => normResult(dec.decode(framesToOgg(frames, serial, seq))),
		flush: () => normResult(dec.flush?.()),
		free: () => dec.free?.()
	}
}

const UNSUPPORTED = { A_EAC3: 'E-AC-3', A_TRUEHD: 'TrueHD', A_MLP: 'MLP', 'A_MS/ACM': 'MS/ACM', 'A_REAL/': 'RealAudio', A_QUICKTIME: 'QuickTime', A_WAVPACK4: 'WavPack', A_TTA1: 'TTA', 'A_MPEG/L2': 'MPEG-1 Layer II', 'A_MPEG/L1': 'MPEG-1 Layer I' }

async function createMatroskaCodec(info) {
	let { codec, codecPrivate } = info
	if (codec.startsWith('A_AAC')) {
		if (!codecPrivate) throw Error('Matroska AAC track has no CodecPrivate (AudioSpecificConfig)')
		let dec = await (await import('@audio/decode-aac')).decoder({ asc: codecPrivate })
		return { feed: frames => dec.decode(frames), flush: () => dec.flush(), free: () => dec.free() }
	}
	if (codec === 'A_ALAC') {
		if (!codecPrivate) throw Error('Matroska ALAC track has no CodecPrivate (magic cookie)')
		let dec = await (await import('@audio/decode-aac')).decoder({ alac: codecPrivate })
		return { feed: frames => dec.decode(frames), flush: () => dec.flush(), free: () => dec.free() }
	}
	// self-synchronizing frame streams: the codec resyncs on concatenated blocks
	let stream = codec === 'A_MPEG/L3' ? import('@audio/decode-mp3')
		: codec === 'A_AC3' || codec.startsWith('A_AC3/') ? import('@audio/decode-ac3')
		: codec === 'A_DTS' || codec.startsWith('A_DTS/') ? import('@audio/decode-dts') : null
	if (stream) {
		let dec = await (await stream).decoder()
		return { feed: frames => dec.decode(concat(frames)), flush: () => dec.flush?.() ?? EMPTY, free: () => dec.free() }
	}
	if (codec === 'A_FLAC') {
		if (!codecPrivate) throw Error('Matroska FLAC track has no CodecPrivate (stream header)')
		let dec = await (await import('@audio/decode-flac')).decoder(), started = false
		return {
			feed: frames => { let bytes = concat(frames); if (!started) { started = true; bytes = concat([codecPrivate, bytes]) } return dec.decode(bytes) },
			flush: () => started ? dec.flush() : EMPTY,
			free: () => dec.free()
		}
	}
	if (codec.startsWith('A_PCM/')) {
		let bits = info.bitDepth || 16
		return pcm({ channels: info.channels, sampleRate: Math.round(info.sampleRate), bits, float: codec === 'A_PCM/FLOAT/IEEE', be: codec === 'A_PCM/INT/BIG' })
	}
	let name = Object.keys(UNSUPPORTED).find(k => codec.startsWith(k))
	throw Error('Unsupported WebM codec: ' + (name ? UNSUPPORTED[name] + ' (' + codec + ')' : codec))
}

// interleaved PCM → planar float. Keeps a partial frame between calls.
function pcm({ channels, sampleRate, bits, float, be }) {
	if (!channels || !sampleRate || !bits) throw Error('Invalid Matroska PCM track')
	let bps = bits >> 3, frame = bps * channels, left = null
	let read = reader(bits, float, be)
	return {
		feed(frames) {
			let buf = left ? concat([left, ...frames]) : concat(frames)
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

function reader(bits, float, be) {
	let le = !be
	if (float) return bits === 64 ? (dv, o) => dv.getFloat64(o, le) : (dv, o) => dv.getFloat32(o, le)
	switch (bits) {
		case 8: return (dv, o) => (dv.getUint8(o) - 128) / 128
		case 16: return (dv, o) => dv.getInt16(o, le) / 32768
		case 24: return be
			? (dv, o) => ((dv.getUint8(o) << 24 | dv.getUint8(o + 1) << 16 | dv.getUint8(o + 2) << 8) >> 8) / 8388608
			: (dv, o) => ((dv.getUint8(o + 2) << 24 | dv.getUint8(o + 1) << 16 | dv.getUint8(o) << 8) >> 8) / 8388608
		case 32: return (dv, o) => dv.getInt32(o, le) / 2147483648
	}
	throw Error('Unsupported PCM bit depth: ' + bits)
}

/**
 * Incremental EBML scanner that extracts audio frames without reparsing the buffer.
 */
class EBMLScanner {
	constructor(trackNum) {
		this.trackNum = trackNum
		this.left = null
	}

	// Feed new data, return extracted audio frames
	feed(chunk) {
		let buf = chunk
		if (this.left) {
			buf = new Uint8Array(this.left.length + chunk.length)
			buf.set(this.left); buf.set(chunk, this.left.length)
			this.left = null
		}
		let frames = [], pos = 0
		while (pos < buf.length) {
			let eid = readId(buf, pos)
			if (!eid) break
			let siz = readSize(buf, pos + eid.len)
			if (!siz) break
			let dataOff = pos + eid.len + siz.len
			let id = eid.val, dataLen = siz.val
			// Master elements: descend (skip element header)
			if (id === ID_SEGMENT || id === ID_CLUSTER || (id === ID_BLOCK_GROUP && dataLen < 0)) { pos = dataOff; continue }
			if (dataLen < 0) break // unknown-size non-master
			if (dataOff + dataLen > buf.length) break // incomplete element
			if (id === ID_BLOCK_GROUP) {
				// Block + DiscardPadding (samples to drop from the end of that block's output)
				let gp = dataOff, gend = dataOff + dataLen, first = frames.length
				while (gp < gend) {
					let cid = readId(buf, gp); if (!cid) break
					let csz = readSize(buf, gp + cid.len); if (!csz || csz.val < 0) break
					let cdata = gp + cid.len + csz.len
					if (cid.val === ID_BLOCK) this.block(buf, cdata, cdata + csz.val, frames)
					else if (cid.val === ID_DISCARD_PADDING && frames.length > first) {
						let ns = readSint(buf, cdata, csz.val)
						if (ns > 0) (frames.discard ??= new Map()).set(frames.length - 1, Math.round(ns * 48000 / 1e9))
					}
					gp = cdata + csz.val
				}
			}
			// SimpleBlock: extract the audio frame(s) — laced blocks carry several
			else if (id === ID_SIMPLE_BLOCK && dataLen > 4) this.block(buf, dataOff, dataOff + dataLen, frames)
			pos = dataOff + dataLen
		}
		if (pos < buf.length) this.left = buf.subarray(pos).slice()
		return frames
	}

	block(buf, bp, end, frames) {
		let tn = readSize(buf, bp)
		if (!tn || tn.val !== this.trackNum) return
		let flags = buf[bp + tn.len + 2]
		bp += tn.len + 3
		if (bp < end) unlace(buf, bp, end, (flags >> 1) & 3, frames)
	}
}

function createOpusStream(info, head, dec) {
	let channels = head.channels || info.channels || 2
	let preSkip = head.preSkip || 0
	if (!preSkip && info.codecDelay) preSkip = Math.round(info.codecDelay / 1e9 * 48000)
	let opts = { channels, sampleRate: 48000, preSkip, outputGain: head.outputGain || 0 }
	if (head.mappingFamily > 0) {
		opts.streamCount = head.streamCount
		opts.coupledStreamCount = head.coupledStreamCount
		opts.channelMappingTable = head.channelMappingTable
	} else if (channels === 1) {
		opts.streamCount = 1; opts.coupledStreamCount = 0; opts.channelMappingTable = [0]
	} else if (channels === 2) {
		opts.streamCount = 1; opts.coupledStreamCount = 1; opts.channelMappingTable = [0, 1]
	}
	dec.configure(opts)
	return { dec, channels }
}

function normResult(result) {
	if (!result?.channelData?.length) return EMPTY
	let { channelData, samplesDecoded, sampleRate } = result
	if (samplesDecoded != null && samplesDecoded < channelData[0].length)
		channelData = channelData.map(ch => ch.subarray(0, samplesDecoded))
	if (!channelData[0]?.length) return EMPTY
	return { channelData, sampleRate }
}

/** Split a block payload into frames per its lacing mode: 0 none, 1 Xiph, 2 fixed, 3 EBML (Matroska §Block Lacing). */
function unlace(buf, start, end, lacing, out) {
	if (!lacing) { out.push(buf.slice(start, end)); return }
	let n = buf[start] + 1, pos = start + 1, sizes = []
	if (lacing === 1) {
		for (let i = 0; i < n - 1; i++) {
			let sz = 0
			while (pos < end && buf[pos] === 255) { sz += 255; pos++ }
			if (pos < end) sz += buf[pos++]
			sizes.push(sz)
		}
	} else if (lacing === 3) {
		let first = readSize(buf, pos)
		if (!first) return
		sizes.push(first.val); pos += first.len
		for (let i = 1; i < n - 1; i++) {
			let v = readSize(buf, pos)
			if (!v) return
			// signed delta: subtract the range bias for this VINT width
			let delta = v.val - (2 ** (7 * v.len - 1) - 1)
			sizes.push(sizes[i - 1] + delta); pos += v.len
		}
	} else if (lacing === 2) {
		let each = Math.floor((end - pos) / n)
		for (let i = 0; i < n - 1; i++) sizes.push(each)
	}
	for (let i = 0; i < n - 1; i++) {
		if (sizes[i] < 0 || pos + sizes[i] > end) return
		out.push(buf.slice(pos, pos + sizes[i])); pos += sizes[i]
	}
	if (pos < end) out.push(buf.slice(pos, end))
}

function concat(parts, totalLen) {
	if (totalLen == null) { totalLen = 0; for (let c of parts) totalLen += c.length }
	let buf = new Uint8Array(totalLen), off = 0
	for (let c of parts) { buf.set(c, off); off += c.length }
	return buf
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
