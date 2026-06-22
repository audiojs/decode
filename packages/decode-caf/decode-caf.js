/**
 * CAF (Core Audio Format) decoder
 * Decodes CAF containers with lpcm, alaw, ulaw audio to Float32 PCM
 *
 * let { channelData, sampleRate } = await decode(cafbuf)
 */

const EMPTY = Object.freeze({ channelData: [], sampleRate: 0 })

/**
 * Whole-file decode
 * @param {Uint8Array|ArrayBuffer} src
 * @returns {Promise<{channelData: Float32Array[], sampleRate: number}>}
 */
export default async function decode(src) {
	let dec = await decoder()
	try { return dec.decode(src) }
	finally { dec.free() }
}

/**
 * Create decoder instance (streaming-aware)
 * @returns {Promise<{decode(chunk: Uint8Array): {channelData, sampleRate}, flush(), free()}>}
 */
export async function decoder() {
	let hdr = null, left = null, freed = false, dataLeft = Infinity
	return {
		decode(data) {
			if (freed) throw Error('Decoder already freed')
			if (!data || !data.byteLength) return EMPTY
			let chunk = data instanceof Uint8Array ? data : new Uint8Array(data)
			if (left) { chunk = catB(left, chunk); left = null }
			if (!hdr) {
				hdr = scanCafHdr(chunk)
				if (!hdr) { left = chunk.slice(); return EMPTY }
				dataLeft = hdr.dataSize
				chunk = chunk.subarray(hdr.dataStart)
			}
			if (dataLeft <= 0) return EMPTY // past the data chunk — ignore trailing chunks
			let fb = hdr.frameBytes
			let avail = Math.min(chunk.length, dataLeft) // don't read past the declared data size
			let complete = Math.floor(avail / fb) * fb
			if (!complete) { if (chunk.length && dataLeft > chunk.length) left = chunk.slice(); return EMPTY }
			dataLeft -= complete
			let rest = chunk.subarray(complete)
			if (rest.length && dataLeft > 0) left = rest.subarray(0, Math.min(rest.length, dataLeft)).slice()
			return decodeCafRaw(chunk.subarray(0, complete), hdr)
		},
		flush() { left = null; return EMPTY },
		free() { freed = true; left = null; hdr = null },
	}
}

function catB(a, b) {
	let r = new Uint8Array(a.length + b.length)
	r.set(a); r.set(b, a.length)
	return r
}

function scanCafHdr(buf) {
	if (buf.length < 8) return null
	if (buf[0] !== 0x63 || buf[1] !== 0x61 || buf[2] !== 0x66 || buf[3] !== 0x66) throw Error('Not a CAF file')
	let dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
	if (dv.getUint16(4, false) !== 1) throw Error('Unsupported CAF version')
	let off = 8, desc = null
	while (off + 12 <= buf.length) {
		let type = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3])
		let sizeHi = dv.getUint32(off + 4, false), sizeLo = dv.getUint32(off + 8, false)
		let size = sizeHi * 0x100000000 + sizeLo
		off += 12
		if (type === 'desc') {
			if (off + 32 > buf.length) return null
			desc = {
				sampleRate: dv.getFloat64(off, false),
				formatID: String.fromCharCode(buf[off + 8], buf[off + 9], buf[off + 10], buf[off + 11]),
				formatFlags: dv.getUint32(off + 12, false),
				bytesPerPacket: dv.getUint32(off + 16, false),
				framesPerPacket: dv.getUint32(off + 20, false),
				channelsPerFrame: dv.getUint32(off + 24, false),
				bitsPerChannel: dv.getUint32(off + 28, false),
			}
		} else if (type === 'data') {
			if (!desc) return null
			let dataStart = off + 4 // skip editCount
			if (dataStart > buf.length) return null
			// -1 (0xFFFF…) size means "until EOF" — read to end; else payload minus 4-byte editCount
			let dataSize = (sizeHi === 0xFFFFFFFF && sizeLo === 0xFFFFFFFF) ? Infinity : Math.max(0, size - 4)
			let { formatID, formatFlags, channelsPerFrame: ch, bitsPerChannel: bits } = desc
			let bytesPerSample = bits >> 3
			let frameBytes
			if (formatID === 'alaw' || formatID === 'ulaw') frameBytes = ch
			else frameBytes = ch * bytesPerSample
			if (!frameBytes) return null
			return { ...desc, dataStart, frameBytes, dataSize }
		}
		if (size < 0) break
		if (sizeHi === 0xFFFFFFFF && sizeLo === 0xFFFFFFFF) break
		off += size
	}
	return null
}

function decodeCafRaw(raw, hdr) {
	let { sampleRate, formatID, formatFlags, channelsPerFrame: ch, bitsPerChannel: bits, frameBytes } = hdr
	let frames = Math.floor(raw.length / frameBytes)
	if (!frames) return EMPTY
	let samples
	if (formatID === 'lpcm') samples = decodeLPCM(raw, formatFlags, bits, ch)
	else if (formatID === 'alaw') samples = decodeAlaw(raw, ch)
	else if (formatID === 'ulaw') samples = decodeUlaw(raw, ch)
	else throw Error('CAF: unsupported format ' + formatID)
	return { channelData: samples, sampleRate }
}

function decodeLPCM(data, flags, bits, ch) {
	let isFloat = flags & 1, isLE = flags & 2
	let bytesPerSample = bits >> 3
	let totalSamples = (data.length / bytesPerSample) | 0
	let framesCount = (totalSamples / ch) | 0
	if (!framesCount) return []

	let dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
	let channelData = Array.from({ length: ch }, () => new Float32Array(framesCount))

	if (isFloat && bits === 32) {
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < ch; c++, off += 4)
				channelData[c][i] = dv.getFloat32(off, !!isLE)
	} else if (isFloat && bits === 64) {
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < ch; c++, off += 8)
				channelData[c][i] = dv.getFloat64(off, !!isLE)
	} else if (bits === 32) {
		let norm = 1 / 2147483648
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < ch; c++, off += 4)
				channelData[c][i] = dv.getInt32(off, !!isLE) * norm
	} else if (bits === 24) {
		let norm = 1 / 8388608
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < ch; c++, off += 3) {
				let s
				if (!isLE) s = (data[off] << 16) | (data[off + 1] << 8) | data[off + 2]
				else s = data[off] | (data[off + 1] << 8) | (data[off + 2] << 16)
				if (s & 0x800000) s |= ~0xFFFFFF
				channelData[c][i] = s * norm
			}
	} else if (bits === 16) {
		let norm = 1 / 32768
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < ch; c++, off += 2)
				channelData[c][i] = dv.getInt16(off, !!isLE) * norm
	} else if (bits === 8) {
		let norm = 1 / 128
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < ch; c++, off++)
				channelData[c][i] = dv.getInt8(off) * norm
	} else {
		throw Error('CAF: unsupported LPCM bit depth ' + bits)
	}

	return channelData
}

function alawDecode(val) {
	val ^= 0x55
	let sign = val & 0x80, seg = (val >> 4) & 7, quant = val & 0x0F
	let sample = seg ? ((quant << 1) | 0x21) << (seg - 1) : (quant << 1) | 1
	return (sign ? -sample : sample) / 32768
}

function ulawDecode(val) {
	val = ~val & 0xFF
	let sign = val & 0x80, exp = (val >> 4) & 7, mant = val & 0x0F
	let sample = ((mant << 1) | 0x21) << exp
	return (sign ? -(sample - 33) : (sample - 33)) / 32768
}

function decodeAlaw(data, ch) {
	let framesCount = (data.length / ch) | 0
	if (!framesCount) return []
	let channelData = Array.from({ length: ch }, () => new Float32Array(framesCount))
	for (let i = 0, off = 0; i < framesCount; i++)
		for (let c = 0; c < ch; c++, off++)
			channelData[c][i] = alawDecode(data[off])
	return channelData
}

function decodeUlaw(data, ch) {
	let framesCount = (data.length / ch) | 0
	if (!framesCount) return []
	let channelData = Array.from({ length: ch }, () => new Float32Array(framesCount))
	for (let i = 0, off = 0; i < framesCount; i++)
		for (let c = 0; c < ch; c++, off++)
			channelData[c][i] = ulawDecode(data[off])
	return channelData
}
