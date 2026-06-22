/**
 * AIFF/AIFF-C decoder — pure JS
 * Decodes AIFF and AIFF-C audio to Float32Array PCM samples
 *
 * let { channelData, sampleRate } = await decode(aiffbuf)
 */

const EMPTY = Object.freeze({ channelData: [], sampleRate: 0 })

// A-law expansion table (ITU-T G.711)
const ALAW_TBL = new Int16Array(256)
// mu-law expansion table (ITU-T G.711)
const ULAW_TBL = new Int16Array(256)

;(function buildTables() {
	for (let i = 0; i < 256; i++) {
		// A-law
		let ax = i ^ 0x55, seg = (ax >> 4) & 7, val = ((ax & 0x0F) << 4) + 8
		if (seg) val = (val + 256) << (seg - 1)
		ALAW_TBL[i] = (ax & 0x80) ? val : -val

		// mu-law (ITU-T G.711) — sign bit set ⇒ negative
		let ux = ~i & 0xFF
		seg = (ux >> 4) & 7
		val = ((ux & 0x0F) << 3) + 132
		val <<= seg
		ULAW_TBL[i] = (ux & 0x80) ? (132 - val) : (val - 132)
	}
})()

/**
 * Read 80-bit IEEE 754 extended precision float
 */
function readF80(b, o) {
	let sign = (b[o] >> 7) & 1
	let exp = ((b[o] & 0x7F) << 8) | b[o + 1]
	let hi = ((b[o + 2] << 24) | (b[o + 3] << 16) | (b[o + 4] << 8) | b[o + 5]) >>> 0
	let lo = ((b[o + 6] << 24) | (b[o + 7] << 16) | (b[o + 8] << 8) | b[o + 9]) >>> 0
	if (exp === 0 && hi === 0 && lo === 0) return 0
	if (exp === 0x7FFF) return sign ? -Infinity : Infinity
	let f = (hi * 4294967296 + lo) / 9223372036854775808 // / 2^63
	return (sign ? -1 : 1) * f * Math.pow(2, exp - 16383)
}

function str4(b, o) {
	return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])
}

function r32(b, o) {
	return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
}

function r16(b, o) {
	return (b[o] << 8) | b[o + 1]
}

/**
 * Parse AIFF/AIFF-C and decode to Float32Array channels
 */
function parseAiff(buf) {
	if (!buf || buf.length < 12) return EMPTY

	let b = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
	if (b.length < 12) return EMPTY

	// Validate FORM header
	if (str4(b, 0) !== 'FORM') throw Error('Not an AIFF file')
	let form = str4(b, 8)
	if (form !== 'AIFF' && form !== 'AIFC') throw Error('Not an AIFF file')
	let isAIFC = form === 'AIFC'

	let nCh = 0, nFrames = 0, bps = 0, sr = 0, comp = 'NONE'
	let ssndOff = -1, ssndSize = 0

	// Parse chunks
	let pos = 12, end = Math.min(8 + r32(b, 4), b.length)
	while (pos + 8 <= end) {
		let ckId = str4(b, pos)
		let ckSize = r32(b, pos + 4)
		let ckData = pos + 8

		if (ckId === 'COMM') {
			if (ckData + 18 > b.length) throw Error('Truncated COMM chunk')
			nCh = r16(b, ckData)
			nFrames = r32(b, ckData + 2)
			bps = r16(b, ckData + 6)
			sr = readF80(b, ckData + 8)
			if (isAIFC && ckSize >= 22 && ckData + 22 <= b.length) {
				comp = str4(b, ckData + 18)
			}
		} else if (ckId === 'SSND') {
			if (ckData + 8 > b.length) throw Error('Truncated SSND chunk')
			let dataOff = r32(b, ckData)
			ssndOff = ckData + 8 + dataOff
			ssndSize = ckSize - 8 - dataOff
		}

		pos = ckData + ckSize + (ckSize & 1) // pad to even
	}

	if (!nCh || !nFrames || !sr || ssndOff < 0) return EMPTY

	// Determine byte depth and decode strategy
	let byteDepth = Math.ceil(bps / 8)
	let frameBytes = byteDepth * nCh
	let actualFrames = Math.min(nFrames, Math.floor(Math.min(ssndSize, b.length - ssndOff) / frameBytes))
	if (actualFrames <= 0) return EMPTY

	let channelData = Array.from({ length: nCh }, () => new Float32Array(actualFrames))
	let p = ssndOff

	// Compression-aware decode
	let cUpper = comp.toUpperCase()
	if (cUpper === 'NONE' || cUpper === 'TWOS' || comp === 'twos') {
		// Big-endian signed integer PCM
		decodePCM_BE(b, p, channelData, actualFrames, nCh, bps, byteDepth)
	} else if (comp === 'sowt') {
		// Little-endian signed integer PCM
		decodePCM_LE(b, p, channelData, actualFrames, nCh, bps, byteDepth)
	} else if (comp === 'fl32' || comp === 'FL32') {
		decodeFloat32_BE(b, p, channelData, actualFrames, nCh)
	} else if (comp === 'fl64' || comp === 'FL64') {
		decodeFloat64_BE(b, p, channelData, actualFrames, nCh)
	} else if (comp === 'alaw') {
		decodeLaw(b, p, channelData, actualFrames, nCh, ALAW_TBL)
	} else if (comp === 'ulaw' || comp === 'ULAW') {
		decodeLaw(b, p, channelData, actualFrames, nCh, ULAW_TBL)
	} else if (comp === 'ima4') {
		return decodeIMA4(b, ssndOff, ssndSize, nCh, nFrames, sr)
	} else if (comp === 'GSM ' || comp === 'gsm ') {
		return decodeGSM(b, ssndOff, ssndSize, nCh, nFrames, sr)
	} else {
		throw Error('Unsupported AIFF-C compression: ' + comp)
	}

	return { channelData, sampleRate: sr }
}

function decodePCM_BE(b, p, channels, frames, nCh, bps, byteDepth) {
	if (bps === 8) {
		// 8-bit: unsigned, center at 128
		for (let i = 0; i < frames; i++)
			for (let c = 0; c < nCh; c++)
				channels[c][i] = (b[p++] - 128) / 128
	} else if (bps === 16) {
		for (let i = 0; i < frames; i++)
			for (let c = 0; c < nCh; c++) {
				let v = (b[p] << 8) | b[p + 1]; p += 2
				channels[c][i] = (v > 32767 ? v - 65536 : v) / 32768
			}
	} else if (bps === 24) {
		for (let i = 0; i < frames; i++)
			for (let c = 0; c < nCh; c++) {
				let v = (b[p] << 16) | (b[p + 1] << 8) | b[p + 2]; p += 3
				channels[c][i] = (v > 8388607 ? v - 16777216 : v) / 8388608
			}
	} else if (bps === 32) {
		for (let i = 0; i < frames; i++)
			for (let c = 0; c < nCh; c++) {
				let v = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]); p += 4
				channels[c][i] = v / 2147483648
			}
	} else {
		throw Error('Unsupported bit depth: ' + bps)
	}
}

function decodePCM_LE(b, p, channels, frames, nCh, bps, byteDepth) {
	if (bps === 8) {
		for (let i = 0; i < frames; i++)
			for (let c = 0; c < nCh; c++)
				channels[c][i] = (b[p++] - 128) / 128
	} else if (bps === 16) {
		for (let i = 0; i < frames; i++)
			for (let c = 0; c < nCh; c++) {
				let v = b[p] | (b[p + 1] << 8); p += 2
				channels[c][i] = (v > 32767 ? v - 65536 : v) / 32768
			}
	} else if (bps === 24) {
		for (let i = 0; i < frames; i++)
			for (let c = 0; c < nCh; c++) {
				let v = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16); p += 3
				channels[c][i] = (v > 8388607 ? v - 16777216 : v) / 8388608
			}
	} else if (bps === 32) {
		for (let i = 0; i < frames; i++)
			for (let c = 0; c < nCh; c++) {
				let v = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24); p += 4
				channels[c][i] = v / 2147483648
			}
	} else {
		throw Error('Unsupported bit depth: ' + bps)
	}
}

function decodeFloat32_BE(b, p, channels, frames, nCh) {
	let dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
	for (let i = 0; i < frames; i++)
		for (let c = 0; c < nCh; c++) {
			channels[c][i] = dv.getFloat32(p, false); p += 4
		}
}

function decodeFloat64_BE(b, p, channels, frames, nCh) {
	let dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
	for (let i = 0; i < frames; i++)
		for (let c = 0; c < nCh; c++) {
			channels[c][i] = dv.getFloat64(p, false); p += 8
		}
}

function decodeLaw(b, p, channels, frames, nCh, tbl) {
	for (let i = 0; i < frames; i++)
		for (let c = 0; c < nCh; c++)
			channels[c][i] = tbl[b[p++]] / 32768
}

// ===== IMA4 ADPCM (Apple IMA ADPCM) =====
// 34 bytes/block/channel → 64 samples. COMM nFrames = number of blocks.

const IMA_STEP = new Int16Array([7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767])
const IMA_IDX = new Int8Array([-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8])

function decodeIMA4(b, ssndOff, ssndSize, nCh, nBlocks, sr) {
	let blockBytes = 34 * nCh
	let totalSamples = nBlocks * 64
	let channelData = Array.from({ length: nCh }, () => new Float32Array(totalSamples))
	let p = ssndOff, sample = 0

	for (let blk = 0; blk < nBlocks && p + blockBytes <= ssndOff + ssndSize; blk++) {
		for (let c = 0; c < nCh; c++) {
			let bp = p + c * 34
			// Preamble: 16-bit BE — high 9 bits = predictor, low 7 bits = step index
			let preamble = (b[bp] << 8) | b[bp + 1]
			let predictor = preamble & 0xFF80 // top 9 bits, sign-extended via int16
			if (predictor > 32767) predictor -= 65536
			let stepIdx = preamble & 0x7F
			if (stepIdx > 88) stepIdx = 88

			let out = channelData[c]
			for (let i = 0; i < 32; i++) {
				let byte = b[bp + 2 + i]
				// High nibble first, then low nibble
				for (let nibbleIdx = 0; nibbleIdx < 2; nibbleIdx++) {
					let nibble = nibbleIdx === 0 ? (byte >> 4) & 0xF : byte & 0xF
					let step = IMA_STEP[stepIdx]
					let diff = step >> 3
					if (nibble & 1) diff += step >> 2
					if (nibble & 2) diff += step >> 1
					if (nibble & 4) diff += step
					if (nibble & 8) diff = -diff
					predictor += diff
					if (predictor > 32767) predictor = 32767
					if (predictor < -32768) predictor = -32768
					stepIdx += IMA_IDX[nibble]
					if (stepIdx < 0) stepIdx = 0
					if (stepIdx > 88) stepIdx = 88
					out[sample + i * 2 + nibbleIdx] = predictor / 32768
				}
			}
		}
		p += blockBytes
		sample += 64
	}

	return { channelData, sampleRate: sr }
}

// ===== GSM 6.10 (Full Rate) =====
// 33 bytes/frame → 160 samples. RPE-LTP speech codec.
// Ported from libgsm by Jutta Degener and Carsten Bormann, TU Berlin.

// Table 4.3b: Quantization levels of the LTP gain quantizer
const GSM_QLB = [3277, 11469, 21299, 32767]
// Table 4.6: Normalized direct mantissa used to compute xM/xmax
const GSM_FAC = [18431, 20479, 22527, 24575, 26623, 28671, 30719, 32767]

// Saturating 16-bit add/sub
function sadd(a, b) { let s = a + b; return s > 32767 ? 32767 : s < -32768 ? -32768 : s }
function ssub(a, b) { let s = a - b; return s > 32767 ? 32767 : s < -32768 ? -32768 : s }
// GSM_MULT_R(a,b): (a*b + 16384) >> 15, with saturation for MIN_WORD*MIN_WORD
function multr(a, b) {
	if (a === -32768 && b === -32768) return 32767
	return ((a * b + 16384) >> 15) | 0
}
// Arithmetic shift right (sign-preserving)
function asr(x, n) {
	if (n >= 16) return x < 0 ? -1 : 0
	if (n <= -16) return 0
	if (n < 0) return x << -n
	return x >> n  // JS >> is always arithmetic
}

function decodeGSM(b, ssndOff, ssndSize, nCh, nFrames, sr) {
	let totalFrames = Math.min(nFrames, Math.floor(ssndSize / 33))
	let channelData = [new Float32Array(totalFrames * 160)]
	let out = channelData[0], p = ssndOff

	// Decoder state (mirrors struct gsm_state)
	let dp0 = new Int32Array(280)  // int32 to avoid overflow in intermediate calcs
	let v = new Int32Array(9)
	let LARpp = [new Int32Array(8), new Int32Array(8)]
	let j = 0, nrp = 40, msr = 0

	for (let f = 0; f < totalFrames; f++) {
		let { LARc, sub } = gsmBits(b, p)
		let wt = new Int32Array(160)

		// Process 4 subframes: RPE decode + long-term synthesis
		for (let s = 0; s < 4; s++) {
			let sf = sub[s]
			let erp = new Int32Array(40)
			gsmRpeDecode(sf.xmaxc, sf.Mc, sf.xmc, erp)

			// Long-term synthesis filtering (4.3.2)
			let Nr = (sf.Nc < 40 || sf.Nc > 120) ? nrp : sf.Nc
			nrp = Nr
			let brp = GSM_QLB[sf.bc]
			// drp is dp0 offset by 120; drp[k] = dp0[120+k], drp[k-Nr] = dp0[120+k-Nr]
			for (let k = 0; k < 40; k++) {
				let drpp = multr(brp, dp0[120 + k - Nr])
				dp0[120 + k] = sadd(erp[k], drpp)
			}
			for (let k = 0; k < 40; k++) wt[s * 40 + k] = dp0[120 + k]

			// Shift dp0: drp[-120+k] = drp[-80+k] for k=0..119
			for (let k = 0; k < 120; k++) dp0[k] = dp0[k + 40]
		}

		// Short-term synthesis filter with LARp interpolation (4.2.8-4.2.9)
		let LARpp_j = LARpp[j]
		let LARpp_j_1 = LARpp[j ^ 1]
		j ^= 1  // toggle for next frame

		gsmDecodeLAR(LARc, LARpp_j)

		let sr_out = new Int32Array(160)
		let LARp = new Int32Array(8)

		// Coefficients_0_12: LARp = 3/4 * prev + 1/4 * curr
		for (let i = 0; i < 8; i++)
			LARp[i] = sadd(sadd(LARpp_j_1[i] >> 2, LARpp_j[i] >> 2), LARpp_j_1[i] >> 1)
		gsmLARpToRp(LARp)
		gsmSynthFilter(v, LARp, 13, wt, 0, sr_out, 0)

		// Coefficients_13_26: LARp = 1/2 * prev + 1/2 * curr
		for (let i = 0; i < 8; i++)
			LARp[i] = sadd(LARpp_j_1[i] >> 1, LARpp_j[i] >> 1)
		gsmLARpToRp(LARp)
		gsmSynthFilter(v, LARp, 14, wt, 13, sr_out, 13)

		// Coefficients_27_39: LARp = 1/4 * prev + 3/4 * curr
		for (let i = 0; i < 8; i++)
			LARp[i] = sadd(sadd(LARpp_j_1[i] >> 2, LARpp_j[i] >> 2), LARpp_j[i] >> 1)
		gsmLARpToRp(LARp)
		gsmSynthFilter(v, LARp, 13, wt, 27, sr_out, 27)

		// Coefficients_40_159: LARp = curr
		for (let i = 0; i < 8; i++) LARp[i] = LARpp_j[i]
		gsmLARpToRp(LARp)
		gsmSynthFilter(v, LARp, 120, wt, 40, sr_out, 40)

		// Postprocessing: de-emphasis + truncation/upscaling
		for (let k = 0; k < 160; k++) {
			msr = sadd(sr_out[k], multr(msr, 28180))
			let s = sadd(msr, msr) & 0xFFF8
			out[f * 160 + k] = (s > 32767 ? s - 65536 : s) / 32768
		}
		p += 33
	}

	return { channelData, sampleRate: sr }
}

// GSM 6.10 bit unpacking: 33 bytes → LARc[8] + 4 subframes
function gsmBits(buf, off) {
	let bc = 0
	function r(n) {
		let val = 0
		for (let i = 0; i < n; i++) {
			val = (val << 1) | ((buf[off + (bc >> 3)] >> (7 - (bc & 7))) & 1)
			bc++
		}
		return val
	}
	let LARc = [r(6),r(6),r(5),r(5),r(4),r(4),r(3),r(3)]
	let sub = []
	for (let s = 0; s < 4; s++)
		sub.push({ Nc: r(7), bc: r(2), Mc: r(2), xmaxc: r(6), xmc: [r(3),r(3),r(3),r(3),r(3),r(3),r(3),r(3),r(3),r(3),r(3),r(3),r(3)] })
	return { LARc, sub }
}

// 4.2.8: Decoding of the coded Log-Area Ratios
function gsmDecodeLAR(LARc, LARpp) {
	// B*2, MIC, INVA from tables 4.1 and 4.2
	const B2   = [0, 0, 4096, -5120, 188, -3584, -682, -2288]
	const MIC  = [-32, -32, -16, -16, -8, -8, -4, -4]
	const INVA = [13107, 13107, 13107, 13107, 19223, 17476, 31454, 29708]
	for (let i = 0; i < 8; i++) {
		let t = sadd(LARc[i], MIC[i]) << 10
		t = ssub(t, B2[i])
		t = multr(INVA[i], t)
		LARpp[i] = sadd(t, t)
	}
}

// 4.2.9.2: LARp to reflection coefficients (in-place)
function gsmLARpToRp(LARp) {
	for (let i = 0; i < 8; i++) {
		if (LARp[i] < 0) {
			let t = LARp[i] === -32768 ? 32767 : -LARp[i]
			LARp[i] = -(t < 11059 ? t << 1 : t < 20070 ? t + 11059 : sadd(t >> 2, 26112))
		} else {
			let t = LARp[i]
			LARp[i] = t < 11059 ? t << 1 : t < 20070 ? t + 11059 : sadd(t >> 2, 26112)
		}
	}
}

// Short-term synthesis filter (4.2.10, synthesis direction)
function gsmSynthFilter(v, rrp, k, wt, wtOff, sr, srOff) {
	for (let n = 0; n < k; n++) {
		let sri = wt[wtOff + n]
		for (let i = 7; i >= 0; i--) {
			sri = ssub(sri, multr(rrp[i], v[i]))
			v[i + 1] = sadd(v[i], multr(rrp[i], sri))
		}
		sr[srOff + n] = v[0] = sri
	}
}

// 4.2.16-4.2.17: RPE decoding (inverse quantization + grid positioning)
function gsmRpeDecode(xmaxc, Mc, xMc, erp) {
	// 4.2.15: Compute exp and mant from xmaxc
	let exp = 0, mant
	if (xmaxc > 15) exp = (xmaxc >> 3) - 1
	mant = xmaxc - (exp << 3)
	if (mant === 0) { exp = -4; mant = 7 }
	else { while (mant <= 7) { mant = (mant << 1) | 1; exp-- }; mant -= 8 }

	// 4.2.16: APCM inverse quantization
	let fac = GSM_FAC[mant]
	let shift = 6 - exp
	let round = shift > 1 ? 1 << (shift - 1) : 0  // gsm_asl(1, shift-1)

	let xMp = new Int32Array(13)
	for (let i = 0; i < 13; i++) {
		let t = ((xMc[i] << 1) - 7) << 12
		t = multr(fac, t)
		t = sadd(t, round)
		xMp[i] = asr(t, shift)
	}

	// 4.2.17: RPE grid positioning
	for (let k = 0; k < 40; k++) erp[k] = 0
	for (let i = 0; i < 13; i++) erp[Mc + 3 * i] = xMp[i]
}

/**
 * Whole-file decode
 * @param {Uint8Array|ArrayBuffer} src
 * @returns {Promise<{channelData: Float32Array[], sampleRate: number}>}
 */
export default async function decode(src) {
	let buf = src instanceof Uint8Array ? src : src instanceof ArrayBuffer ? new Uint8Array(src) : src
	let dec = await decoder()
	try {
		let result = dec.decode(buf)
		if (!result.channelData.length) result = dec.flush()
		return result
	} finally {
		dec.free()
	}
}

/**
 * Create decoder instance
 * @returns {Promise<{decode(chunk: Uint8Array): {channelData, sampleRate}, flush(), free()}>}
 */
export async function decoder() {
	let hdr = null, left = null, freed = false
	return {
		decode(data) {
			if (freed) throw Error('Decoder already freed')
			if (!data?.length) return EMPTY
			let chunk = data instanceof Uint8Array ? data : new Uint8Array(data)
			if (left) { chunk = cat(left, chunk); left = null }
			if (!hdr) {
				hdr = scanAiffHdr(chunk)
				if (!hdr) { left = chunk.slice(); return EMPTY }
				// IMA4/GSM: buffer all SSND data, decode on flush
				if (hdr.comp === 'ima4' || hdr.comp === 'GSM ' || hdr.comp === 'gsm ') {
					left = chunk.slice()
					return EMPTY
				}
				chunk = chunk.subarray(hdr.dataStart)
			}
			let fb = hdr.frameBytes
			let complete = Math.floor(chunk.length / fb) * fb
			if (!complete) { if (chunk.length) left = chunk.slice(); return EMPTY }
			if (chunk.length > complete) left = chunk.subarray(complete).slice()
			return decodeAiffRaw(chunk.subarray(0, complete), hdr)
		},
		flush() {
			if (hdr && left && (hdr.comp === 'ima4' || hdr.comp === 'GSM ' || hdr.comp === 'gsm ')) {
				let result = parseAiff(left)
				left = null
				return result
			}
			left = null
			return EMPTY
		},
		free() { freed = true; left = null; hdr = null },
	}
}

function cat(a, b) {
	let r = new Uint8Array(a.length + b.length)
	r.set(a); r.set(b, a.length)
	return r
}

function scanAiffHdr(b) {
	if (!b || b.length < 12) return null
	if (str4(b, 0) !== 'FORM') throw Error('Not an AIFF file')
	let form = str4(b, 8)
	if (form !== 'AIFF' && form !== 'AIFC') throw Error('Not an AIFF file')
	let isAIFC = form === 'AIFC'
	let nCh = 0, bps = 0, sr = 0, comp = 'NONE', commFound = false, numSampleFrames = 0
	let pos = 12, end = Math.min(8 + r32(b, 4), b.length)
	while (pos + 8 <= end) {
		let ckId = str4(b, pos), ckSize = r32(b, pos + 4), ckData = pos + 8
		if (ckId === 'COMM') {
			if (ckData + 18 > b.length) return null
			nCh = r16(b, ckData)
			numSampleFrames = r32(b, ckData + 2)
			bps = r16(b, ckData + 6)
			sr = readF80(b, ckData + 8)
			if (isAIFC && ckSize >= 22 && ckData + 22 <= b.length) comp = str4(b, ckData + 18)
			commFound = true
		} else if (ckId === 'SSND') {
			if (!commFound) return null
			if (ckData + 8 > b.length) return null
			let dataOff = r32(b, ckData)
			let dataStart = ckData + 8 + dataOff
			let ssndDataSize = ckSize - 8 - dataOff
			let cUpper = comp.toUpperCase()
			let byteDepth = Math.ceil(bps / 8)
			let frameBytes
			if (comp === 'fl32' || comp === 'FL32') frameBytes = nCh * 4
			else if (comp === 'fl64' || comp === 'FL64') frameBytes = nCh * 8
			else if (comp === 'alaw' || comp === 'ulaw' || comp === 'ULAW') frameBytes = nCh
			else if (comp === 'ima4' || comp === 'GSM ' || comp === 'gsm ') frameBytes = 1 // block-based, handled via flush
			else frameBytes = nCh * byteDepth
			let maxFrames = numSampleFrames ? Math.min(numSampleFrames, Math.floor(ssndDataSize / frameBytes)) : 0
			return { nCh, bps, sr, comp, byteDepth, frameBytes, dataStart, isAIFC, maxFrames, ssndDataSize }
		}
		pos = ckData + ckSize + (ckSize & 1)
	}
	return null
}

function decodeAiffRaw(raw, hdr) {
	let { nCh, bps, sr, comp, byteDepth, frameBytes, maxFrames } = hdr
	let frames = Math.floor(raw.length / frameBytes)
	if (maxFrames) frames = Math.min(frames, maxFrames)
	if (!frames) return EMPTY
	let channelData = Array.from({ length: nCh }, () => new Float32Array(frames))
	let cUpper = comp.toUpperCase()
	let p = 0
	if (cUpper === 'NONE' || cUpper === 'TWOS' || comp === 'twos') {
		decodePCM_BE(raw, 0, channelData, frames, nCh, bps, byteDepth)
	} else if (comp === 'sowt') {
		decodePCM_LE(raw, 0, channelData, frames, nCh, bps, byteDepth)
	} else if (comp === 'fl32' || comp === 'FL32') {
		decodeFloat32_BE(raw, 0, channelData, frames, nCh)
	} else if (comp === 'fl64' || comp === 'FL64') {
		decodeFloat64_BE(raw, 0, channelData, frames, nCh)
	} else if (comp === 'alaw') {
		decodeLaw(raw, 0, channelData, frames, nCh, ALAW_TBL)
	} else if (comp === 'ulaw' || comp === 'ULAW') {
		decodeLaw(raw, 0, channelData, frames, nCh, ULAW_TBL)
	} else {
		throw Error('Unsupported AIFF-C compression: ' + comp)
	}
	return { channelData, sampleRate: sr }
}
