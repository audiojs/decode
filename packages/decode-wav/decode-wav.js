/**
 * WAV decoder — pure JS / ESM
 * Decodes WAV audio to Float32Array samples:
 *   PCM 8/16/24/32-bit int, 32/64-bit float, G.711 A-law / µ-law,
 *   plus WAVE_FORMAT_EXTENSIBLE wrapping any of the above.
 *
 * let { channelData, sampleRate } = await decode(wavbuf)
 */

const EMPTY = Object.freeze({ channelData: [], sampleRate: 0 })

// WAVE format tag → codec. EXTENSIBLE (0xFFFE) is resolved to its SubFormat tag.
const WAV_CODECS = { 1: 'pcm', 3: 'float', 6: 'alaw', 7: 'ulaw' }

// G.711 expansion tables (ITU-T) — int16 PCM per encoded byte
const ALAW_TBL = new Int16Array(256)
const ULAW_TBL = new Int16Array(256)
for (let i = 0; i < 256; i++) {
	let ax = i ^ 0x55, seg = (ax >> 4) & 7, val = ((ax & 0x0F) << 4) + 8
	if (seg) val = (val + 256) << (seg - 1)
	ALAW_TBL[i] = (ax & 0x80) ? val : -val

	let ux = ~i & 0xFF
	seg = (ux >> 4) & 7
	val = ((ux & 0x0F) << 3) + 132
	val <<= seg
	ULAW_TBL[i] = (ux & 0x80) ? (132 - val) : (val - 132)
}

export default async function decode(src) {
	let dec = await decoder()
	try { return dec.decode(src instanceof Uint8Array ? src : new Uint8Array(src)) }
	finally { dec.free() }
}

export async function decoder() {
	let hdr = null, left = null, freed = false, dataLeft = Infinity
	return {
		decode(data) {
			if (freed) throw Error('Decoder already freed')
			if (!data?.length) return EMPTY
			let chunk = data instanceof Uint8Array ? data : new Uint8Array(data)
			if (left) { chunk = cat(left, chunk); left = null }
			if (!hdr) {
				hdr = scanWavHdr(chunk)
				if (!hdr) { left = chunk.slice(); return EMPTY }
				// 0 / 0xFFFFFFFF are streaming placeholders — read to end
				dataLeft = hdr.dataSize > 0 && hdr.dataSize < 0xFFFFFFFF ? hdr.dataSize : Infinity
				chunk = chunk.subarray(hdr.dataStart)
			}
			if (dataLeft <= 0) return EMPTY // past the data chunk — ignore trailing chunks
			let fb = hdr.blockSize
			let avail = Math.min(chunk.length, dataLeft) // don't read past the declared data size
			let complete = Math.floor(avail / fb) * fb
			if (!complete) { if (chunk.length && dataLeft > chunk.length) left = chunk.slice(); return EMPTY }
			dataLeft -= complete
			let rest = chunk.subarray(complete)
			if (rest.length && dataLeft > 0) left = rest.subarray(0, Math.min(rest.length, dataLeft)).slice()
			return decodeRaw(chunk.subarray(0, complete), hdr)
		},
		flush() { left = null; return EMPTY },
		free() { freed = true; left = null; hdr = null },
	}
}

function cat(a, b) {
	let r = new Uint8Array(a.length + b.length)
	r.set(a); r.set(b, a.length)
	return r
}

function s4(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) }

function scanWavHdr(b) {
	// reject non-WAV as soon as the magic is readable; only buffer when a valid header is still arriving
	if (b.length >= 4 && s4(b, 0) !== 'RIFF') throw TypeError('Not a WAV file')
	if (b.length < 12) return null
	let dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
	if (s4(b, 8) !== 'WAVE') throw TypeError('Not a WAV file')
	let pos = 12, fmt = null
	while (pos + 8 <= b.length) {
		let type = s4(b, pos), size = dv.getUint32(pos + 4, true)
		if (type === 'fmt ') {
			if (pos + 24 > b.length) return null
			let fid = dv.getUint16(pos + 8, true)
			// WAVE_FORMAT_EXTENSIBLE: real codec is the first 2 bytes of the SubFormat GUID
			if (fid === 0xFFFE) {
				if (pos + 48 > b.length) return null
				fid = dv.getUint16(pos + 32, true)
			}
			let codec = WAV_CODECS[fid]
			if (!codec) throw TypeError('Unsupported WAV format: 0x' + fid.toString(16))
			fmt = {
				codec, channels: dv.getUint16(pos + 10, true),
				sampleRate: dv.getUint32(pos + 12, true),
				blockSize: dv.getUint16(pos + 20, true), bitDepth: dv.getUint16(pos + 22, true),
			}
		} else if (type === 'data') {
			if (!fmt) return null
			return { ...fmt, dataStart: pos + 8, dataSize: size }
		}
		pos += 8 + size
	}
	return null
}

function decodeRaw(raw, hdr) {
	let { channels: nCh, bitDepth, codec, sampleRate, blockSize } = hdr
	let frames = Math.floor(raw.length / blockSize)
	if (!frames) return EMPTY
	let ch = Array.from({ length: nCh }, () => new Float32Array(frames))
	let dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
	let p = 0
	let isFloat = codec === 'float'
	if (codec === 'alaw' || codec === 'ulaw') {
		let tbl = codec === 'alaw' ? ALAW_TBL : ULAW_TBL
		for (let i = 0; i < frames; i++) for (let c = 0; c < nCh; c++) ch[c][i] = tbl[raw[p++]] / 32768
	} else if (isFloat && bitDepth === 64) {
		for (let i = 0; i < frames; i++) for (let c = 0; c < nCh; c++) { ch[c][i] = dv.getFloat64(p, true); p += 8 }
	} else if (isFloat && bitDepth === 32) {
		for (let i = 0; i < frames; i++) for (let c = 0; c < nCh; c++) { ch[c][i] = dv.getFloat32(p, true); p += 4 }
	} else if (bitDepth === 8) {
		for (let i = 0; i < frames; i++) for (let c = 0; c < nCh; c++) {
			let v = raw[p++] - 128; ch[c][i] = v < 0 ? v / 128 : v / 127
		}
	} else if (bitDepth === 16) {
		for (let i = 0; i < frames; i++) for (let c = 0; c < nCh; c++) {
			let v = dv.getInt16(p, true); p += 2; ch[c][i] = v < 0 ? v / 32768 : v / 32767
		}
	} else if (bitDepth === 24) {
		for (let i = 0; i < frames; i++) for (let c = 0; c < nCh; c++) {
			let v = raw[p] | (raw[p + 1] << 8) | (raw[p + 2] << 16); p += 3
			if (v >= 0x800000) v -= 0x1000000
			ch[c][i] = v < 0 ? v / 8388608 : v / 8388607
		}
	} else if (bitDepth === 32) {
		for (let i = 0; i < frames; i++) for (let c = 0; c < nCh; c++) {
			let v = dv.getInt32(p, true); p += 4; ch[c][i] = v < 0 ? v / 2147483648 : v / 2147483647
		}
	} else { throw TypeError('Unsupported WAV bit depth: ' + bitDepth) }
	return { channelData: ch, sampleRate }
}
