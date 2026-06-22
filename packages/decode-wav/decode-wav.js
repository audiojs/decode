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
const WAV_CODECS = { 1: 'pcm', 3: 'float', 6: 'alaw', 7: 'ulaw', 2: 'ms', 0x11: 'ima' }

// IMA/DVI ADPCM tables (ITU-T / Intel)
const IMA_STEP = new Int16Array([7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767])
const IMA_IDX = new Int8Array([-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8])

// MS ADPCM adaptation table + default predictor coefficients
const MS_ADAPT = new Int16Array([230,230,230,230,307,409,512,614,768,614,512,409,307,230,230,230])
const MS_DEFAULT_COEFS = [[256,0],[512,-256],[0,0],[192,64],[240,0],[460,-208],[392,-232]]

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
			// ADPCM: block-based — read samples-per-block (+ predictor coefs for MS) from the fmt extension
			if (codec === 'ima' || codec === 'ms') {
				if (pos + 8 + size > b.length) return null // wait for the full fmt chunk
				let nCh = fmt.channels, ba = fmt.blockSize
				let cbSize = dv.getUint16(pos + 24, true)
				fmt.samplesPerBlock = cbSize >= 2 ? dv.getUint16(pos + 26, true) : 0
				if (codec === 'ima') {
					if (!fmt.samplesPerBlock) fmt.samplesPerBlock = 1 + (ba / nCh - 4) * 2
				} else {
					if (!fmt.samplesPerBlock) fmt.samplesPerBlock = 2 + (ba - 7 * nCh) * 2 / nCh
					let nCoef = cbSize >= 4 ? dv.getUint16(pos + 28, true) : 0
					let coefs = []
					for (let i = 0; i < nCoef; i++)
						coefs.push([dv.getInt16(pos + 30 + i * 4, true), dv.getInt16(pos + 32 + i * 4, true)])
					fmt.coefs = coefs.length ? coefs : MS_DEFAULT_COEFS
				}
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
	if (codec === 'ima') return decodeImaWav(raw, hdr)
	if (codec === 'ms') return decodeMsWav(raw, hdr)
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

// IMA/DVI ADPCM — per channel: 4-byte header (predictor int16 + step index), then
// 4-byte words round-robin across channels, low nibble first, 8 samples per word.
function decodeImaWav(raw, hdr) {
	let { channels: nCh, blockSize: ba, samplesPerBlock: spb, sampleRate } = hdr
	let nBlocks = Math.floor(raw.length / ba)
	let ch = Array.from({ length: nCh }, () => new Float32Array(nBlocks * spb))
	let dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
	for (let blk = 0; blk < nBlocks; blk++) {
		let base = blk * ba, outBase = blk * spb
		let pred = new Int32Array(nCh), idx = new Int32Array(nCh), cnt = new Int32Array(nCh)
		for (let c = 0; c < nCh; c++) {
			pred[c] = dv.getInt16(base + c * 4, true)
			idx[c] = Math.min(raw[base + c * 4 + 2], 88)
			ch[c][outBase] = pred[c] / 32768
			cnt[c] = 1
		}
		let p = base + nCh * 4, nWords = Math.ceil((spb - 1) / 8)
		for (let w = 0; w < nWords; w++) {
			for (let c = 0; c < nCh; c++, p += 4) {
				let out = ch[c], pr = pred[c], ix = idx[c]
				for (let n = 0; n < 4; n++) {
					let byte = raw[p + n]
					for (let half = 0; half < 2; half++) {
						let nib = half === 0 ? (byte & 0x0F) : (byte >> 4)
						let step = IMA_STEP[ix]
						let diff = ((2 * (nib & 7) + 1) * step) >> 3
						pr += (nib & 8) ? -diff : diff
						if (pr > 32767) pr = 32767; else if (pr < -32768) pr = -32768
						ix += IMA_IDX[nib]
						if (ix < 0) ix = 0; else if (ix > 88) ix = 88
						if (cnt[c] < spb) out[outBase + cnt[c]++] = pr / 32768
					}
				}
				pred[c] = pr; idx[c] = ix
			}
		}
	}
	return { channelData: ch, sampleRate }
}

// MS ADPCM — per channel: predictor index byte, then int16 delta, sample1, sample2.
// Stereo interleaves one nibble per channel per byte (high=L, low=R); mono packs two.
function decodeMsWav(raw, hdr) {
	let { channels: nCh, blockSize: ba, samplesPerBlock: spb, sampleRate, coefs } = hdr
	let nBlocks = Math.floor(raw.length / ba)
	let ch = Array.from({ length: nCh }, () => new Float32Array(nBlocks * spb))
	let dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
	let predIdx = new Int32Array(nCh), delta = new Int32Array(nCh), s1 = new Int32Array(nCh), s2 = new Int32Array(nCh)
	let expand = (nib, c) => {
		let signed = nib >= 8 ? nib - 16 : nib
		let co = coefs[predIdx[c]]
		let pr = (s1[c] * co[0] + s2[c] * co[1]) >> 8
		pr += signed * delta[c]
		if (pr > 32767) pr = 32767; else if (pr < -32768) pr = -32768
		s2[c] = s1[c]; s1[c] = pr
		delta[c] = (MS_ADAPT[nib] * delta[c]) >> 8
		if (delta[c] < 16) delta[c] = 16
		return pr / 32768
	}
	for (let blk = 0; blk < nBlocks; blk++) {
		let base = blk * ba, outBase = blk * spb, p = base
		for (let c = 0; c < nCh; c++) predIdx[c] = Math.min(raw[p++], coefs.length - 1)
		for (let c = 0; c < nCh; c++) { delta[c] = dv.getInt16(p, true); p += 2 }
		for (let c = 0; c < nCh; c++) { s1[c] = dv.getInt16(p, true); p += 2 }
		for (let c = 0; c < nCh; c++) { s2[c] = dv.getInt16(p, true); p += 2 }
		for (let c = 0; c < nCh; c++) { ch[c][outBase] = s2[c] / 32768; ch[c][outBase + 1] = s1[c] / 32768 }
		let cnt = 2
		if (nCh === 1) {
			while (cnt < spb) {
				let byte = raw[p++]
				ch[0][outBase + cnt++] = expand(byte >> 4, 0)
				if (cnt < spb) ch[0][outBase + cnt++] = expand(byte & 0x0F, 0)
			}
		} else {
			while (cnt < spb) {
				let byte = raw[p++]
				ch[0][outBase + cnt] = expand(byte >> 4, 0)
				ch[1][outBase + cnt] = expand(byte & 0x0F, 1)
				cnt++
			}
		}
	}
	return { channelData: ch, sampleRate }
}
