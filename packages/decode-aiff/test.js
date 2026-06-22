import decode, { decoder } from './decode-aiff.js'
import { readFileSync } from 'fs'

let pass = 0, fail = 0
function ok(cond, msg) {
	if (cond) { pass++; console.log('  ok', msg) }
	else { fail++; console.log('  FAIL', msg) }
}
function near(a, b, tol = 0.01) { return Math.abs(a - b) < tol }
function rms(ch) { let s = 0; for (let v of ch) s += v * v; return Math.sqrt(s / ch.length) }

// ===== AIFF fixture builders =====

function writeF80(buf, off, val) {
	// Encode a positive float as 80-bit IEEE 754 extended
	if (val === 0) { buf.fill(0, off, off + 10); return }
	let sign = 0
	if (val < 0) { sign = 1; val = -val }
	let exp = Math.floor(Math.log2(val))
	let frac = val / Math.pow(2, exp)
	// frac is in [1, 2), mantissa has explicit integer bit
	let biasedExp = exp + 16383
	let mantissa = frac * 9223372036854775808 // * 2^63
	let hi = Math.floor(mantissa / 4294967296) >>> 0
	let lo = (mantissa - hi * 4294967296) >>> 0
	buf[off] = (sign << 7) | ((biasedExp >> 8) & 0x7F)
	buf[off + 1] = biasedExp & 0xFF
	buf[off + 2] = (hi >> 24) & 0xFF
	buf[off + 3] = (hi >> 16) & 0xFF
	buf[off + 4] = (hi >> 8) & 0xFF
	buf[off + 5] = hi & 0xFF
	buf[off + 6] = (lo >> 24) & 0xFF
	buf[off + 7] = (lo >> 16) & 0xFF
	buf[off + 8] = (lo >> 8) & 0xFF
	buf[off + 9] = lo & 0xFF
}

function w32(buf, off, v) {
	buf[off] = (v >> 24) & 0xFF; buf[off + 1] = (v >> 16) & 0xFF
	buf[off + 2] = (v >> 8) & 0xFF; buf[off + 3] = v & 0xFF
}

function w16(buf, off, v) {
	buf[off] = (v >> 8) & 0xFF; buf[off + 1] = v & 0xFF
}

function writeStr(buf, off, s) {
	for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i)
}

/** Build AIFF (not AIFF-C) buffer */
function buildAIFF({ sr = 44100, nCh = 1, bps = 16, samples }) {
	let nFrames = samples.length / nCh
	let byteDepth = bps / 8
	let dataSize = nFrames * nCh * byteDepth
	let commSize = 18
	let ssndSize = 8 + dataSize
	let formSize = 4 + (8 + commSize) + (8 + ssndSize)

	let buf = new Uint8Array(12 + (8 + commSize) + (8 + ssndSize))
	let p = 0

	// FORM header
	writeStr(buf, p, 'FORM'); p += 4
	w32(buf, p, formSize); p += 4
	writeStr(buf, p, 'AIFF'); p += 4

	// COMM chunk
	writeStr(buf, p, 'COMM'); p += 4
	w32(buf, p, commSize); p += 4
	w16(buf, p, nCh); p += 2
	w32(buf, p, nFrames); p += 4
	w16(buf, p, bps); p += 2
	writeF80(buf, p, sr); p += 10

	// SSND chunk
	writeStr(buf, p, 'SSND'); p += 4
	w32(buf, p, ssndSize); p += 4
	w32(buf, p, 0); p += 4 // offset
	w32(buf, p, 0); p += 4 // blockSize

	// Interleaved PCM data (big-endian)
	for (let i = 0; i < samples.length; i++) {
		let s = samples[i]
		if (bps === 8) {
			buf[p++] = Math.round(s * 128 + 128)
		} else if (bps === 16) {
			let v = Math.round(s * 32768)
			v = Math.max(-32768, Math.min(32767, v))
			if (v < 0) v += 65536
			w16(buf, p, v); p += 2
		} else if (bps === 24) {
			let v = Math.round(s * 8388608)
			v = Math.max(-8388608, Math.min(8388607, v))
			if (v < 0) v += 16777216
			buf[p] = (v >> 16) & 0xFF; buf[p + 1] = (v >> 8) & 0xFF; buf[p + 2] = v & 0xFF; p += 3
		} else if (bps === 32) {
			let v = Math.round(s * 2147483648)
			v = Math.max(-2147483648, Math.min(2147483647, v))
			w32(buf, p, v); p += 4
		}
	}

	return buf
}

/** Build AIFF-C buffer */
function buildAIFC({ sr = 44100, nCh = 1, bps = 16, comp = 'NONE', samples, rawData }) {
	let nFrames = rawData ? rawData.length / nCh / (bps / 8) : samples.length / nCh
	let byteDepth = bps / 8
	let dataSize = rawData ? rawData.length : nFrames * nCh * byteDepth
	// COMM: 18 + 4 (compType) + 2 (pascal string: 1-byte len + 1 pad for "not compressed")
	let compName = '\x00' // minimal pascal string (0-length + pad)
	let commSize = 18 + 4 + 2
	let ssndSize = 8 + dataSize
	let formSize = 4 + (8 + commSize) + (8 + ssndSize)

	let buf = new Uint8Array(12 + (8 + commSize) + (8 + ssndSize))
	let p = 0

	writeStr(buf, p, 'FORM'); p += 4
	w32(buf, p, formSize); p += 4
	writeStr(buf, p, 'AIFC'); p += 4

	// COMM
	writeStr(buf, p, 'COMM'); p += 4
	w32(buf, p, commSize); p += 4
	w16(buf, p, nCh); p += 2
	w32(buf, p, nFrames); p += 4
	w16(buf, p, bps); p += 2
	writeF80(buf, p, sr); p += 10
	writeStr(buf, p, comp); p += 4
	buf[p] = 0; p += 1 // pascal string length 0
	buf[p] = 0; p += 1 // pad

	// SSND
	writeStr(buf, p, 'SSND'); p += 4
	w32(buf, p, ssndSize); p += 4
	w32(buf, p, 0); p += 4
	w32(buf, p, 0); p += 4

	if (rawData) {
		buf.set(rawData, p)
		p += rawData.length
	} else {
		// Write big-endian PCM
		for (let i = 0; i < samples.length; i++) {
			let s = samples[i]
			if (bps === 16) {
				let v = Math.round(s * 32768)
				v = Math.max(-32768, Math.min(32767, v))
				if (v < 0) v += 65536
				w16(buf, p, v); p += 2
			}
		}
	}

	return buf
}

// Generate sine wave samples (interleaved)
function sine(freq, sr, nFrames, nCh = 1) {
	let out = new Array(nFrames * nCh)
	for (let i = 0; i < nFrames; i++) {
		let v = Math.sin(2 * Math.PI * freq * i / sr) * 0.5
		for (let c = 0; c < nCh; c++) out[i * nCh + c] = v
	}
	return out
}

// Generate stereo sine (different freqs per channel)
function stereoSine(freqL, freqR, sr, nFrames) {
	let out = new Array(nFrames * 2)
	for (let i = 0; i < nFrames; i++) {
		out[i * 2] = Math.sin(2 * Math.PI * freqL * i / sr) * 0.5
		out[i * 2 + 1] = Math.sin(2 * Math.PI * freqR * i / sr) * 0.5
	}
	return out
}


// ---- Mono 16-bit decode ----
console.log('mono 16-bit AIFF')
{
	let samples = sine(440, 44100, 1000)
	let aiff = buildAIFF({ sr: 44100, nCh: 1, bps: 16, samples })
	let r = await decode(aiff)
	ok(r.channelData.length === 1, 'mono')
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(r.channelData[0].length === 1000, '1000 frames')
	// Verify sine values (allow quantization error for 16-bit)
	ok(near(r.channelData[0][0], 0, 0.001), 'starts near 0')
	let maxAbs = 0
	for (let v of r.channelData[0]) maxAbs = Math.max(maxAbs, Math.abs(v))
	ok(near(maxAbs, 0.5, 0.01), 'peak ~0.5')
}

// ---- Stereo 16-bit decode ----
console.log('stereo 16-bit AIFF')
{
	let samples = stereoSine(440, 880, 44100, 1000)
	let aiff = buildAIFF({ sr: 44100, nCh: 2, bps: 16, samples })
	let r = await decode(aiff)
	ok(r.channelData.length === 2, 'stereo')
	ok(r.channelData[0].length === 1000, '1000 frames')
	ok(r.channelData[1].length === 1000, '1000 frames R')
	// Channels should differ (440 vs 880 Hz)
	let diff = 0
	for (let i = 0; i < 1000; i++) diff += Math.abs(r.channelData[0][i] - r.channelData[1][i])
	ok(diff > 1, 'L/R channels differ')
}

// ---- 8-bit decode ----
console.log('8-bit AIFF')
{
	let samples = sine(440, 44100, 500)
	let aiff = buildAIFF({ sr: 44100, nCh: 1, bps: 8, samples })
	let r = await decode(aiff)
	ok(r.channelData.length === 1, 'mono')
	ok(r.channelData[0].length === 500, '500 frames')
	let maxAbs = 0
	for (let v of r.channelData[0]) maxAbs = Math.max(maxAbs, Math.abs(v))
	ok(near(maxAbs, 0.5, 0.05), '8-bit peak ~0.5')
}

// ---- 24-bit decode ----
console.log('24-bit AIFF')
{
	let samples = sine(440, 44100, 500)
	let aiff = buildAIFF({ sr: 44100, nCh: 1, bps: 24, samples })
	let r = await decode(aiff)
	ok(r.channelData.length === 1, 'mono')
	ok(r.channelData[0].length === 500, '500 frames')
	// 24-bit should have very low quantization error
	ok(near(r.channelData[0][0], 0, 0.0001), '24-bit precision near 0')
}

// ---- 32-bit decode ----
console.log('32-bit AIFF')
{
	let samples = sine(440, 44100, 500)
	let aiff = buildAIFF({ sr: 44100, nCh: 1, bps: 32, samples })
	let r = await decode(aiff)
	ok(r.channelData.length === 1, 'mono')
	ok(r.channelData[0].length === 500, '500 frames')
}

// ---- AIFF-C NONE ----
console.log('AIFF-C NONE compression')
{
	let samples = sine(440, 44100, 500)
	let aiff = buildAIFC({ sr: 44100, nCh: 1, bps: 16, comp: 'NONE', samples })
	let r = await decode(aiff)
	ok(r.channelData.length === 1, 'mono')
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(r.channelData[0].length === 500, '500 frames')
}

// ---- AIFF-C sowt (little-endian) ----
console.log('AIFF-C sowt (little-endian)')
{
	let nFrames = 500
	let samples = sine(440, 44100, nFrames)
	// Build LE raw data
	let rawData = new Uint8Array(nFrames * 2)
	for (let i = 0; i < nFrames; i++) {
		let v = Math.round(samples[i] * 32768)
		v = Math.max(-32768, Math.min(32767, v))
		if (v < 0) v += 65536
		rawData[i * 2] = v & 0xFF
		rawData[i * 2 + 1] = (v >> 8) & 0xFF
	}
	let aiff = buildAIFC({ sr: 44100, nCh: 1, bps: 16, comp: 'sowt', rawData })
	let r = await decode(aiff)
	ok(r.channelData.length === 1, 'mono')
	ok(r.channelData[0].length === 500, '500 frames')
	let maxAbs = 0
	for (let v of r.channelData[0]) maxAbs = Math.max(maxAbs, Math.abs(v))
	ok(near(maxAbs, 0.5, 0.01), 'sowt peak ~0.5')
}

// ---- AIFF-C fl32 (32-bit float BE) ----
console.log('AIFF-C fl32 (32-bit float BE)')
{
	let nFrames = 500
	let samples = sine(440, 44100, nFrames)
	let rawData = new Uint8Array(nFrames * 4)
	let dv = new DataView(rawData.buffer)
	for (let i = 0; i < nFrames; i++) dv.setFloat32(i * 4, samples[i], false)
	let aiff = buildAIFC({ sr: 44100, nCh: 1, bps: 32, comp: 'fl32', rawData })
	let r = await decode(aiff)
	ok(r.channelData.length === 1, 'mono')
	ok(r.channelData[0].length === 500, '500 frames')
	ok(near(r.channelData[0][0], 0, 0.0001), 'fl32 precision')
	let maxAbs = 0
	for (let v of r.channelData[0]) maxAbs = Math.max(maxAbs, Math.abs(v))
	ok(near(maxAbs, 0.5, 0.001), 'fl32 peak ~0.5')
}

// ---- AIFF-C fl64 (64-bit float BE) ----
console.log('AIFF-C fl64 (64-bit float BE)')
{
	let nFrames = 500
	let samples = sine(440, 44100, nFrames)
	let rawData = new Uint8Array(nFrames * 8)
	let dv = new DataView(rawData.buffer)
	for (let i = 0; i < nFrames; i++) dv.setFloat64(i * 8, samples[i], false)
	let aiff = buildAIFC({ sr: 44100, nCh: 1, bps: 64, comp: 'fl64', rawData })
	let r = await decode(aiff)
	ok(r.channelData.length === 1, 'mono')
	ok(r.channelData[0].length === 500, '500 frames')
	ok(near(r.channelData[0][0], 0, 0.0001), 'fl64 precision')
}

// ---- Sample rate parsing ----
console.log('sample rate parsing')
{
	for (let sr of [22050, 44100, 48000, 96000]) {
		let aiff = buildAIFF({ sr, nCh: 1, bps: 16, samples: sine(440, sr, 100) })
		let r = await decode(aiff)
		ok(near(r.sampleRate, sr, 1), 'sampleRate ' + sr)
	}
}

// ---- Trailing chunk after SSND (issue #46) ----
console.log('trailing chunk after SSND')
{
	// Build AIFF with 100 frames of silence, then an ID3 chunk with garbage after SSND
	let nFrames = 100
	let samples = new Array(nFrames).fill(0)
	let base = buildAIFF({ sr: 44100, nCh: 1, bps: 16, samples })

	// Append a fake ID3 chunk (4 id + 4 size + 128 bytes of non-zero garbage)
	let trailingSize = 128
	let trailing = new Uint8Array(8 + trailingSize)
	writeStr(trailing, 0, 'ID3 ')
	w32(trailing, 4, trailingSize)
	trailing.fill(0xFF, 8)

	let aiff = new Uint8Array(base.length + trailing.length)
	aiff.set(base)
	aiff.set(trailing, base.length)
	// Update FORM size
	w32(aiff, 4, r32(base, 4) + trailing.length)

	function r32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0 }

	let r = await decode(aiff)
	ok(r.channelData[0].length === nFrames, 'no extra frames from trailing chunk (got ' + r.channelData[0].length + ', expected ' + nFrames + ')')
	// All samples should be silence (0), not noise
	let maxAbs = 0
	for (let v of r.channelData[0]) maxAbs = Math.max(maxAbs, Math.abs(v))
	ok(maxAbs === 0, 'trailing garbage not decoded as audio (max=' + maxAbs + ')')
}

// ---- Edge cases ----
console.log('edge cases')
{
	// empty input
	let d = await decoder()
	let r = d.decode(new Uint8Array(0))
	ok(r.channelData.length === 0, 'empty input -> EMPTY')
	d.free()

	// null input
	d = await decoder()
	r = d.decode(null)
	ok(r.channelData.length === 0, 'null input -> EMPTY')
	d.free()

	// garbage input
	d = await decoder()
	let garbage = new Uint8Array(1000)
	crypto.getRandomValues(garbage)
	try {
		r = d.decode(garbage)
		ok(r.channelData.length === 0, 'garbage -> EMPTY or error')
	} catch {
		ok(true, 'garbage -> threw (ok)')
	}
	d.free()

	// truncated (valid FORM header, no chunks)
	d = await decoder()
	let trunc = new Uint8Array(12)
	writeStr(trunc, 0, 'FORM')
	w32(trunc, 4, 4)
	writeStr(trunc, 8, 'AIFF')
	r = d.decode(trunc)
	ok(r.channelData.length === 0, 'truncated -> EMPTY')
	d.free()

	// too short
	d = await decoder()
	r = d.decode(new Uint8Array(5))
	ok(r.channelData.length === 0, 'too short -> EMPTY')
	d.free()
}

// ---- Lifecycle ----
console.log('lifecycle')
{
	let samples = sine(440, 44100, 100)
	let aiff = buildAIFF({ sr: 44100, nCh: 1, bps: 16, samples })

	// decode after free throws
	let d = await decoder()
	d.free()
	let threw = false
	try { d.decode(aiff) } catch { threw = true }
	ok(threw, 'decode after free throws')

	// double free safe
	d = await decoder()
	d.decode(aiff)
	d.free()
	d.free()
	ok(true, 'double free ok')

	// flush returns EMPTY
	d = await decoder()
	d.decode(aiff)
	let f = d.flush()
	ok(f.channelData.length === 0, 'flush returns EMPTY')
	ok(f.sampleRate === 0, 'flush sampleRate 0')
	d.free()
}

// ---- ArrayBuffer input ----
console.log('ArrayBuffer input')
{
	let samples = sine(440, 44100, 100)
	let aiff = buildAIFF({ sr: 44100, nCh: 1, bps: 16, samples })
	let r = await decode(aiff.buffer.slice(aiff.byteOffset, aiff.byteOffset + aiff.length))
	ok(r.channelData.length === 1, 'ArrayBuffer input works')
	ok(r.sampleRate === 44100, 'ArrayBuffer sampleRate')
}

// ---- AIFF-C ulaw ----
console.log('AIFF-C ulaw')
{
	// Build mu-law encoded data from known sine
	let nFrames = 500
	let samples = sine(440, 44100, nFrames)

	// Encode to mu-law (simplified: use linear-to-ulaw encoding)
	function encodeUlaw(sample) {
		let MU = 255, s = Math.max(-1, Math.min(1, sample))
		let sign = s < 0 ? 0x80 : 0
		s = Math.abs(s)
		// mu-law compression
		let mag = Math.min(32635, Math.round(s * 32768))
		mag += 0x84
		let exp = 7
		for (let expMask = 0x4000; (mag & expMask) === 0 && exp > 0; exp--, expMask >>= 1) {}
		let mant = (mag >> (exp + 3)) & 0x0F
		let ulawByte = ~(sign | (exp << 4) | mant) & 0xFF
		return ulawByte
	}

	let rawData = new Uint8Array(nFrames)
	for (let i = 0; i < nFrames; i++) rawData[i] = encodeUlaw(samples[i])

	let aiff = buildAIFC({ sr: 44100, nCh: 1, bps: 8, comp: 'ulaw', rawData })
	let r = await decode(aiff)
	ok(r.channelData.length === 1, 'ulaw mono')
	ok(r.channelData[0].length === 500, 'ulaw 500 frames')
	// mu-law should produce audio with roughly correct amplitude
	let maxAbs = 0
	for (let v of r.channelData[0]) maxAbs = Math.max(maxAbs, Math.abs(v))
	ok(maxAbs > 0.1, 'ulaw has audio content')
}

// ---- AIFF-C alaw ----
console.log('AIFF-C alaw')
{
	let nFrames = 500
	let samples = sine(440, 44100, nFrames)

	function encodeAlaw(sample) {
		let s = Math.max(-1, Math.min(1, sample))
		let sign = s < 0 ? 0 : 0x80
		let mag = Math.min(32767, Math.round(Math.abs(s) * 32768))
		let exp = 7
		for (let expMask = 0x4000; (mag & expMask) === 0 && exp > 0; exp--, expMask >>= 1) {}
		let mant = exp === 0 ? (mag >> 4) & 0x0F : (mag >> (exp + 3)) & 0x0F
		return ((sign | (exp << 4) | mant) ^ 0x55) & 0xFF
	}

	let rawData = new Uint8Array(nFrames)
	for (let i = 0; i < nFrames; i++) rawData[i] = encodeAlaw(samples[i])

	let aiff = buildAIFC({ sr: 44100, nCh: 1, bps: 8, comp: 'alaw', rawData })
	let r = await decode(aiff)
	ok(r.channelData.length === 1, 'alaw mono')
	ok(r.channelData[0].length === 500, 'alaw 500 frames')
	let maxAbs = 0
	for (let v of r.channelData[0]) maxAbs = Math.max(maxAbs, Math.abs(v))
	ok(maxAbs > 0.1, 'alaw has audio content')
}

// ---- No NaN/Inf ----
console.log('data integrity')
{
	let samples = sine(440, 44100, 1000)
	let aiff = buildAIFF({ sr: 44100, nCh: 1, bps: 16, samples })
	let r = await decode(aiff)
	let bad = 0
	for (let ch of r.channelData) for (let i = 0; i < ch.length; i++) if (!isFinite(ch[i])) bad++
	ok(bad === 0, 'no NaN/Inf in output')
}

// ---- Sequential determinism ----
console.log('sequential determinism')
{
	let samples = sine(440, 44100, 1000, 2)
	let buf = buildAIFF({ sr: 44100, nCh: 2, bps: 16, samples })
	let r1 = await decode(buf)
	let r2 = await decode(buf)
	ok(r1.channelData[0].length === r2.channelData[0].length, 'same length')
	ok(r1.sampleRate === r2.sampleRate, 'same sampleRate')
	let maxDiff = 0
	for (let i = 0; i < r1.channelData[0].length; i++)
		maxDiff = Math.max(maxDiff, Math.abs(r1.channelData[0][i] - r2.channelData[0][i]))
	ok(maxDiff === 0, 'identical output')
}

// ---- Concurrent decoders ----
console.log('concurrent decoders')
{
	let samples = sine(440, 44100, 1000, 2)
	let buf = buildAIFF({ sr: 44100, nCh: 2, bps: 16, samples })
	let [r1, r2] = await Promise.all([decode(buf), decode(buf)])
	ok(r1.channelData[0].length === r2.channelData[0].length, 'same length')
	ok(r1.sampleRate === r2.sampleRate, 'same sampleRate')
}

// ---- Performance ----
console.log('performance')
{
	let samples = sine(440, 44100, 44100, 2)
	let buf = buildAIFF({ sr: 44100, nCh: 2, bps: 16, samples })
	// warmup
	await decode(buf)
	let t0 = performance.now(), N = 100
	for (let i = 0; i < N; i++) await decode(buf)
	let ms = (performance.now() - t0) / N
	ok(ms < 50, 'decode < 50ms (' + ms.toFixed(2) + 'ms)')
	console.log('  ' + ms.toFixed(2) + 'ms/decode')
}

// ===== Real file tests =====

let lenaPath = (f) => new URL('' + f, import.meta.resolve('audio-lena'))

// ---- Real file: 16-bit mono ----
console.log('real file: 16-bit mono')
{
	let aiff = readFileSync(lenaPath('lena.aiff'))
	let r = await decode(aiff)
	ok(r.channelData.length === 1, 'mono')
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(near(r.channelData[0].length / r.sampleRate, 12.29, 0.1), 'duration ~12.29s')
	ok(rms(r.channelData[0]) > 0.05, 'has audio content')
	let bad = 0
	for (let ch of r.channelData) for (let i = 0; i < ch.length; i++) if (!isFinite(ch[i])) bad++
	ok(bad === 0, 'no NaN/Inf')
}

// ---- Real file: 24-bit mono ----
console.log('real file: 24-bit mono')
{
	let aiff = readFileSync(lenaPath('lena-24.aiff'))
	let r = await decode(aiff)
	ok(r.channelData.length === 1, 'mono')
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(near(r.channelData[0].length / r.sampleRate, 12.27, 0.1), 'duration ~12.27s')
	ok(rms(r.channelData[0]) > 0.05, 'has audio content')
	let bad = 0
	for (let ch of r.channelData) for (let i = 0; i < ch.length; i++) if (!isFinite(ch[i])) bad++
	ok(bad === 0, 'no NaN/Inf')
}

// ---- Real file: 32-bit mono ----
console.log('real file: 32-bit mono')
{
	let aiff = readFileSync(lenaPath('lena-32.aiff'))
	let r = await decode(aiff)
	ok(r.channelData.length === 1, 'mono')
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(near(r.channelData[0].length / r.sampleRate, 12.27, 0.1), 'duration ~12.27s')
	ok(rms(r.channelData[0]) > 0.05, 'has audio content')
	let bad = 0
	for (let ch of r.channelData) for (let i = 0; i < ch.length; i++) if (!isFinite(ch[i])) bad++
	ok(bad === 0, 'no NaN/Inf')
}

// ---- Real file: A-law ----
console.log('real file: alaw')
{
	let aiff = readFileSync(lenaPath('lena-alaw.aiff'))
	let r = await decode(aiff)
	ok(r.channelData.length === 1, 'mono')
	ok(r.sampleRate === 8000, 'sampleRate 8000')
	ok(near(r.channelData[0].length / r.sampleRate, 12.27, 0.1), 'duration ~12.27s')
	ok(rms(r.channelData[0]) > 0.01, 'has audio content')
	let bad = 0
	for (let ch of r.channelData) for (let i = 0; i < ch.length; i++) if (!isFinite(ch[i])) bad++
	ok(bad === 0, 'no NaN/Inf')
}

// ---- Real file: mu-law ----
console.log('real file: ulaw')
{
	let aiff = readFileSync(lenaPath('lena-ulaw.aiff'))
	let r = await decode(aiff)
	ok(r.channelData.length === 1, 'mono')
	ok(r.sampleRate === 8000, 'sampleRate 8000')
	ok(near(r.channelData[0].length / r.sampleRate, 12.27, 0.1), 'duration ~12.27s')
	ok(rms(r.channelData[0]) > 0.01, 'has audio content')
	let bad = 0
	for (let ch of r.channelData) for (let i = 0; i < ch.length; i++) if (!isFinite(ch[i])) bad++
	ok(bad === 0, 'no NaN/Inf')
}

// ---- Real file: cross-bitdepth RMS consistency ----
console.log('real file: cross-bitdepth consistency')
{
	let r16 = await decode(readFileSync(lenaPath('lena.aiff')))
	let r24 = await decode(readFileSync(lenaPath('lena-24.aiff')))
	let r32 = await decode(readFileSync(lenaPath('lena-32.aiff')))
	let rms16 = rms(r16.channelData[0]), rms24 = rms(r24.channelData[0]), rms32 = rms(r32.channelData[0])
	ok(near(rms16, rms24, 0.01), 'RMS 16 vs 24 close (' + rms16.toFixed(4) + ' vs ' + rms24.toFixed(4) + ')')
	ok(near(rms24, rms32, 0.001), 'RMS 24 vs 32 close (' + rms24.toFixed(4) + ' vs ' + rms32.toFixed(4) + ')')
}

// ---- Performance (real file) ----
console.log('performance (real file)')
{
	let aiff = readFileSync(lenaPath('lena.aiff'))
	await decode(aiff) // warmup
	let t0 = performance.now(), N = 20
	for (let i = 0; i < N; i++) await decode(aiff)
	let ms = (performance.now() - t0) / N
	ok(ms < 100, 'real file decode < 100ms (' + ms.toFixed(1) + 'ms)')
	console.log('  ' + ms.toFixed(1) + 'ms/decode (1MB, 12.3s audio)')
}

// ---- Audacity exports ----
console.log('audacity: 24-bit')
{
	let r = await decode(readFileSync(new URL('audacity/lena-24.aiff', import.meta.resolve('audio-lena'))))
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(near(r.channelData[0].length / r.sampleRate, 12.27, 0.1), 'duration ~12.27s')
	ok(rms(r.channelData[0]) > 0.05, 'has audio')
}

console.log('audacity: 64-bit float')
{
	let r = await decode(readFileSync(new URL('audacity/lena-64.aiff', import.meta.resolve('audio-lena'))))
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(rms(r.channelData[0]) > 0.05, 'has audio')
}

console.log('audacity: IMA ADPCM (ima4)')
{
	let r = await decode(readFileSync(new URL('audacity/lena-ima-adpcm.aiff', import.meta.resolve('audio-lena'))))
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(near(r.channelData[0].length / r.sampleRate, 12.27, 0.1), 'duration ~12.27s')
	ok(rms(r.channelData[0]) > 0.05, 'has audio')
}

console.log('audacity: GSM 6.10')
{
	let r = await decode(readFileSync(new URL('audacity/lena-gsm.aiff', import.meta.resolve('audio-lena'))))
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(near(r.channelData[0].length / r.sampleRate, 12.27, 0.1), 'duration ~12.27s')
	ok(rms(r.channelData[0]) > 0.05, 'has audio (GSM)')
}

console.log('audacity: mu-law 44.1kHz')
{
	let r = await decode(readFileSync(new URL('audacity/lena-u.aiff', import.meta.resolve('audio-lena'))))
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(rms(r.channelData[0]) > 0.05, 'has audio')
}

console.log('audacity: A-law 44.1kHz')
{
	let r = await decode(readFileSync(new URL('audacity/lena-a.aiff', import.meta.resolve('audio-lena'))))
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(rms(r.channelData[0]) > 0.05, 'has audio')
}

// ---- Logic Pro exports ----
console.log('logic: 24-bit')
{
	let r = await decode(readFileSync(new URL('logic/lena-24.aif', import.meta.resolve('audio-lena'))))
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(near(r.channelData[0].length / r.sampleRate, 12.27, 0.1), 'duration ~12.27s')
	ok(rms(r.channelData[0]) > 0.05, 'has audio')
}

console.log('logic: 32-bit float')
{
	let r = await decode(readFileSync(new URL('logic/lena-32.aif', import.meta.resolve('audio-lena'))))
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(near(r.channelData[0].length / r.sampleRate, 12.27, 0.1), 'duration ~12.27s')
	ok(rms(r.channelData[0]) > 0.05, 'has audio')
}

// ---- AIFF-C G.711 sign/scale regression (real ffmpeg fixtures, 440Hz sine) ----
console.log('aifc G.711 vs reference sine')
{
	let sineRef = (n, freq = 440, sr = 8000) => Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * freq * i / sr))
	let corr = (a, b) => {
		let n = Math.min(a.length, b.length), sa = 0, sb = 0, sab = 0
		for (let i = 0; i < n; i++) { sa += a[i] * a[i]; sb += b[i] * b[i]; sab += a[i] * b[i] }
		return sab / Math.sqrt(sa * sb)
	}
	for (let name of ['mulaw', 'alaw']) {
		let r = await decode(readFileSync(new URL('./fixtures/' + name + '.aifc', import.meta.url)))
		ok(r.sampleRate === 8000, name + ': sampleRate 8000')
		// correct decode correlates ~+1 with the source sine; a sign flip scores ~-1
		ok(corr(r.channelData[0], sineRef(r.channelData[0].length)) > 0.97, name + ': matches 440Hz sine (sign + scale)')
	}
}

console.log(`\n${pass + fail} tests, ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
