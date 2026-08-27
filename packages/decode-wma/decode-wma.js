/**
 * WMA decoder — ASF demuxer (pure JS) + RockBox wmadec (WASM)
 * Decodes WMA v1/v2 in ASF containers
 *
 * let { channelData, sampleRate } = await decode(wmabuf)
 */

import createWMA from './src/wma.wasm.js'

const EMPTY = Object.freeze({ channelData: [], sampleRate: 0 })

// ASF GUIDs (16 bytes each, little-endian)
const GUID = {
	header:      [0x30,0x26,0xb2,0x75,0x8e,0x66,0xcf,0x11,0xa6,0xd9,0x00,0xaa,0x00,0x62,0xce,0x6c],
	fileProps:   [0xa1,0xdc,0xab,0x8c,0x47,0xa9,0xcf,0x11,0x8e,0xe4,0x00,0xc0,0x0c,0x20,0x53,0x65],
	streamProps: [0x91,0x07,0xdc,0xb7,0xb7,0xa9,0xcf,0x11,0x8e,0xe6,0x00,0xc0,0x0c,0x20,0x53,0x65],
	audioMedia:  [0x40,0x9e,0x69,0xf8,0x4d,0x5b,0xcf,0x11,0xa8,0xfd,0x00,0x80,0x5f,0x5c,0x44,0x2b],
	data:        [0x36,0x26,0xb2,0x75,0x8e,0x66,0xcf,0x11,0xa6,0xd9,0x00,0xaa,0x00,0x62,0xce,0x6c],
	headerExt:   [0xb5,0x03,0xbf,0x5f,0x2e,0xa9,0xcf,0x11,0x8e,0xe3,0x00,0xc0,0x0c,0x20,0x53,0x65],
}

function guidEq(buf, off, guid) {
	for (let i = 0; i < 16; i++) if (buf[off + i] !== guid[i]) return false
	return true
}

// Little-endian readers
function u16(b, o) { return b[o] | (b[o + 1] << 8) }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 }
function u64(b, o) {
	// JS safe up to 2^53; read low 32 + high 32
	let lo = u32(b, o), hi = u32(b, o + 4)
	return hi * 0x100000000 + lo
}

/**
 * Parse ASF container — extract audio stream properties + data packets
 * @param {Uint8Array} buf
 * @returns {{ channels, sampleRate, bitRate, blockAlign, bitsPerSample, formatTag, codecData, duration, packetSize, packets }}
 */
export function demuxASF(buf) {
	if (!(buf instanceof Uint8Array)) buf = new Uint8Array(buf)
	if (buf.length < 30) throw Error('Not an ASF/WMA file')

	// Verify ASF Header Object GUID
	if (!guidEq(buf, 0, GUID.header)) throw Error('Not an ASF/WMA file')

	let headerSize = u64(buf, 16)
	let numObjects = u32(buf, 24)
	// reserved1(1) + reserved2(1) at offset 28-29

	let audio = null    // WAVEFORMATEX fields
	let packetSize = 0
	let duration = 0    // in seconds
	let datOff = 0      // data object offset
	let datSize = 0     // data object total size
	let totalPackets = 0

	// Parse header sub-objects
	let pos = 30
	let headerEnd = Math.min(Number(headerSize), buf.length)
	for (let i = 0; i < numObjects && pos < headerEnd - 24; i++) {
		let objSize = u64(buf, pos + 16)
		if (objSize < 24) break
		let objEnd = pos + Math.min(Number(objSize), headerEnd - pos)

		if (guidEq(buf, pos, GUID.streamProps)) {
			audio = parseStreamProps(buf, pos + 24, objEnd) || audio
		} else if (guidEq(buf, pos, GUID.fileProps)) {
			let fp = parseFileProps(buf, pos + 24, objEnd)
			if (fp) { packetSize = fp.packetSize; duration = fp.duration }
		} else if (guidEq(buf, pos, GUID.headerExt)) {
			// Header Extension Object — nested sub-objects skipped (no metadata needed for decode)
		}

		pos = objEnd
	}

	if (!audio) throw Error('No audio stream in ASF')

	// Find Data Object after header
	pos = Number(headerSize)
	if (pos + 50 <= buf.length && guidEq(buf, pos, GUID.data)) {
		datSize = u64(buf, pos + 16)
		// fileId(16) + totalPackets(8) + reserved(2) = 26 bytes after object header
		totalPackets = u64(buf, pos + 24 + 16)
		datOff = pos + 24 + 26 // start of packet data
	}

	// Extract packets
	let packets = []
	if (datOff && packetSize > 0) {
		let datEnd = Math.min(pos + Number(datSize), buf.length)
		let ppos = datOff
		while (ppos + packetSize <= datEnd) {
			packets.push(buf.subarray(ppos, ppos + packetSize))
			ppos += packetSize
		}
	} else if (datOff && totalPackets > 0) {
		// Variable-size packets — fallback: treat remaining data as one blob
		let datEnd = Math.min(pos + Number(datSize), buf.length)
		if (datOff < datEnd) packets.push(buf.subarray(datOff, datEnd))
	}

	return {
		channels: audio.channels,
		sampleRate: audio.sampleRate,
		bitRate: audio.avgBytesPerSec * 8,
		blockAlign: audio.blockAlign,
		bitsPerSample: audio.bitsPerSample,
		formatTag: audio.formatTag,
		codecData: audio.codecData,
		duration,
		packetSize,
		packets
	}
}

/**
 * Parse Stream Properties Object body
 * Returns audio WAVEFORMATEX fields if this is an audio stream, null otherwise
 */
function parseStreamProps(buf, start, end) {
	// Stream Type GUID(16) + Error Correction Type GUID(16) + Time Offset(8)
	// + Type-Specific Data Length(4) + Error Correction Data Length(4)
	// + Flags(2) + Reserved(4)
	if (start + 54 > end) return null

	// Check that stream type is Audio Media
	if (!guidEq(buf, start, GUID.audioMedia)) return null

	// flags(2) + reserved(4) = 6 bytes after type/ec data lengths
	let waveOff = start + 54

	if (waveOff + 18 > end) return null

	// WAVEFORMATEX
	let formatTag = u16(buf, waveOff)
	let channels = u16(buf, waveOff + 2)
	let sampleRate = u32(buf, waveOff + 4)
	let avgBytesPerSec = u32(buf, waveOff + 8)
	let blockAlign = u16(buf, waveOff + 12)
	let bitsPerSample = u16(buf, waveOff + 14)
	let cbSize = u16(buf, waveOff + 16)

	// Codec-specific data follows WAVEFORMATEX
	let codecData = null
	if (cbSize > 0 && waveOff + 18 + cbSize <= end) {
		codecData = buf.subarray(waveOff + 18, waveOff + 18 + cbSize)
	}

	return { formatTag, channels, sampleRate, avgBytesPerSec, blockAlign, bitsPerSample, codecData }
}

/**
 * Parse File Properties Object body
 * Returns { packetSize, duration } or null
 */
function parseFileProps(buf, start, end) {
	// File ID(16) + File Size(8) + Creation Date(8) + Data Packets Count(8)
	// + Play Duration(8) + Send Duration(8) + Preroll(8)
	// + Flags(4) + Min Data Packet Size(4) + Max Data Packet Size(4)
	// + Max Bitrate(4)
	if (start + 80 > end) return null

	// Play Duration is 100-ns units (offset 40)
	let playDur = u64(buf, start + 40)
	// Preroll in ms (offset 56)
	let preroll = u64(buf, start + 56)
	// Duration in seconds
	let duration = Math.max(0, playDur / 10000000 - preroll / 1000)

	// Max packet size at offset 72 (min at 68, always equal for WMA)
	let packetSize = u32(buf, start + 72)

	return { packetSize, duration }
}

/**
 * Parse ASF data packet — extract compressed audio payload(s)
 * Returns array of payload buffers
 */
export function parsePacket(pkt, packetSize) {
	if (!pkt || pkt.length < 3) return []

	let pos = 0

	// Error Correction — first byte flags
	let ecFlags = pkt[pos++]
	if (ecFlags & 0x80) {
		// Error correction present
		let ecLen = ecFlags & 0x0F
		// Opaque data flag is bit 4
		pos += ecLen
	}

	if (pos >= pkt.length) return []

	// Payload Parsing Information
	let ppFlags = pkt[pos++]
	let lenFlags = pkt[pos++]

	let multiplePayloads = !!(ppFlags & 0x01)
	let seqType = (ppFlags >> 1) & 0x03
	let padType = (ppFlags >> 3) & 0x03
	let pktLenType = (ppFlags >> 5) & 0x03

	let repType = lenFlags & 0x03
	let offType = (lenFlags >> 2) & 0x03
	let medNumType = (lenFlags >> 4) & 0x03

	// Skip optional packet length field
	if (pktLenType === 1) pos += 1
	else if (pktLenType === 2) pos += 2
	else if (pktLenType === 3) pos += 4

	// Sequence (skip)
	if (seqType === 1) pos += 1
	else if (seqType === 2) pos += 2
	else if (seqType === 3) pos += 4

	// Padding length
	let padLen = 0
	if (padType === 1) { padLen = pkt[pos++] }
	else if (padType === 2) { padLen = u16(pkt, pos); pos += 2 }
	else if (padType === 3) { padLen = u32(pkt, pos); pos += 4 }

	// Send time (4 bytes) + duration (2 bytes)
	pos += 6

	if (pos >= pkt.length) return []

	let payloads = []

	if (!multiplePayloads) {
		// Single payload — rest of packet minus padding
		pos += 1 // stream number (always 1 byte)

		// Media object number
		pos += fieldSize(medNumType)

		// Offset into media object
		pos += fieldSize(offType)

		// Replicated data length
		let repLen = readVarField(pkt, pos, repType)
		pos += fieldSize(repType)

		// Skip replicated data
		if (repLen === 1) {
			// Compressed payload: repLen==1 means compressed
			pos += 1 // presentation time delta
		} else {
			pos += repLen
		}

		let payloadLen = pkt.length - pos - padLen
		if (payloadLen > 0 && pos + payloadLen <= pkt.length) {
			payloads.push(pkt.subarray(pos, pos + payloadLen))
		}
	} else {
		// Multiple payloads
		let payloadFlags = pkt[pos++]
		let numPayloads = payloadFlags & 0x3F
		let payLenType = (payloadFlags >> 6) & 0x03

		for (let i = 0; i < numPayloads && pos < pkt.length; i++) {
			// Stream number (1 byte, lower 7 = number, bit 7 = key frame)
			pos += 1

			// Media object number
			pos += fieldSize(medNumType)

			// Offset into media object
			pos += fieldSize(offType)

			// Replicated data
			let repLen = readVarField(pkt, pos, repType)
			pos += fieldSize(repType)

			if (repLen === 1) {
				pos += 1 // compressed: presentation time delta
			} else {
				pos += repLen
			}

			// Payload length
			let payLen = 0
			if (payLenType === 1) { payLen = pkt[pos++] }
			else if (payLenType === 2) { payLen = u16(pkt, pos); pos += 2 }
			else if (payLenType === 3) { payLen = u32(pkt, pos); pos += 4 }
			else { payLen = pkt.length - pos }

			if (payLen > 0 && pos + payLen <= pkt.length) {
				payloads.push(pkt.subarray(pos, pos + payLen))
			}
			pos += payLen
		}
	}

	return payloads
}

function fieldSize(type) {
	return type === 0 ? 0 : type === 1 ? 1 : type === 2 ? 2 : 4
}

function readVarField(buf, off, type) {
	if (type === 0) return 0
	if (type === 1) return buf[off] || 0
	if (type === 2) return (off + 2 <= buf.length) ? u16(buf, off) : 0
	return (off + 4 <= buf.length) ? u32(buf, off) : 0
}

// ===== WMA format tag names =====

const WMA_FORMATS = {
	0x0160: 'WMAv1',
	0x0161: 'WMAv2',
	0x0162: 'WMAPro',
	0x0163: 'WMALossless',
}

// ===== WASM module loader =====

let _modP

async function getMod() {
	if (_modP) return _modP
	let p = createWMA()
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
	return new WMADecoder(await getMod())
}

class WMADecoder {
	constructor(mod) {
		this.m = mod
		this.h = null
		this.sr = 0
		this.ch = 0
		this.done = false
		this._ptr = 0
		this._cap = 0
		this._meta = null // parsed ASF metadata
		this._left = null // leftover bytes (partial packet)
	}

	decode(data) {
		if (this.done) throw Error('Decoder already freed')
		if (!data || !data.byteLength) return EMPTY

		let buf = data instanceof Uint8Array ? data : new Uint8Array(data)
		if (this._left) { buf = catW(this._left, buf); this._left = null }

		// Phase 1: parse header, init WASM, decode initial packets
		if (!this._meta) {
			let asf
			try { asf = demuxASF(buf) } catch {
				this._left = buf.slice()
				return EMPTY
			}

			if (!asf.packets.length && !asf.packetSize) return EMPTY

			let fmt = WMA_FORMATS[asf.formatTag]
			if (!fmt) throw Error('Unsupported WMA format tag: 0x' + asf.formatTag.toString(16))
			this.sr = asf.sampleRate
			this.ch = asf.channels
			this._meta = asf

			let m = this.m
			let extraPtr = 0, extraLen = 0
			if (asf.codecData?.length) {
				extraPtr = this._alloc(asf.codecData.length)
				m.HEAPU8.set(asf.codecData, extraPtr)
				extraLen = asf.codecData.length
			}
			this.h = m._wma_create(
				asf.channels, asf.sampleRate, asf.bitRate,
				asf.blockAlign, asf.formatTag, asf.bitsPerSample,
				extraPtr, extraLen
			)
			if (!this.h) throw Error('WMA decoder init failed')

			// Compute data start + consumed offset to keep leftover
			let headerSize = u64(buf, 16)
			let datOff = Number(headerSize) + 50
			let consumed = datOff + asf.packets.length * asf.packetSize
			if (consumed < buf.length) this._left = buf.subarray(consumed).slice()

			if (!asf.packets.length) return EMPTY
			return this._decodePkts(asf.packets, asf)
		}

		// Phase 2: incremental — extract fixed-size packets from new data
		let ps = this._meta.packetSize
		if (!ps) { this._left = buf; return EMPTY } // variable-size: accumulate, decode on flush
		let pkts = []
		let pos = 0
		while (pos + ps <= buf.length) {
			pkts.push(buf.subarray(pos, pos + ps))
			pos += ps
		}
		if (pos < buf.length) this._left = buf.subarray(pos).slice()
		if (!pkts.length) return EMPTY
		return this._decodePkts(pkts, this._meta)
	}

	_decodePkts(pkts, asf) {
		let m = this.m
		let chunks = [], totalPerCh = 0, channels = this.ch, errors = 0
		let ba = asf.blockAlign

		for (let pkt of pkts) {
			let payloads = parsePacket(pkt, asf.packetSize)
			for (let payload of payloads) {
				for (let off = 0; off + ba <= payload.length; off += ba) {
					let frame = payload.subarray(off, off + ba)
					let ptr = this._alloc(ba)
					m.HEAPU8.set(frame, ptr)
					let out = m._wma_decode(this.h, ptr, ba)
					if (!out) { errors++; continue }

					let n = m._wma_samples()
					let sr = m._wma_samplerate()
					if (sr) this.sr = sr
					let ch = m._wma_channels()
					if (ch) channels = ch

					let spc = n / channels
					chunks.push({ data: new Float32Array(m.HEAPF32.buffer, out, n).slice(), ch: channels, spc })
					totalPerCh += spc
				}
			}
		}

		if (!totalPerCh) {
			if (errors) throw Error(errors + ' frame(s) failed to decode')
			return EMPTY
		}

		let channelData = Array.from({ length: channels }, () => new Float32Array(totalPerCh))
		let pos = 0
		for (let { data, ch, spc } of chunks) {
			for (let c = 0; c < ch; c++) {
				let out = channelData[c]
				for (let s = 0; s < spc; s++) out[pos + s] = data[s * ch + c]
			}
			pos += spc
		}

		return { channelData, sampleRate: this.sr }
	}

	flush() {
		let r = EMPTY
		if (this._left && this._meta && !this._meta.packetSize) r = this._decodePkts([this._left], this._meta)
		this._left = null
		return r
	}

	free() {
		if (this.done) return
		this.done = true
		if (this.h) {
			this.m._wma_close(this.h)
			this.m._wma_free_buf()
			this.h = null
		}
		if (this._ptr) {
			this.m._free(this._ptr)
			this._ptr = 0
			this._cap = 0
		}
		this._left = null; this._meta = null
	}

	_alloc(len) {
		if (len > this._cap) {
			if (this._ptr) this.m._free(this._ptr)
			this._cap = len
			this._ptr = this.m._malloc(len)
		}
		return this._ptr
	}
}

function catW(a, b) {
	let r = new Uint8Array(a.length + b.length)
	r.set(a); r.set(b, a.length)
	return r
}
