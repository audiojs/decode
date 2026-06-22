import decode, { decoder } from './decode-caf.js'
import { readFileSync } from 'fs'

let pass = 0, fail = 0
function ok(cond, msg) {
	if (cond) { pass++; console.log('  ok', msg) }
	else { fail++; console.log('  FAIL', msg) }
}
function near(a, b, tol = 0.01) { return Math.abs(a - b) < tol }
function rms(arr) { let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i]; return Math.sqrt(s / arr.length) }

// ===== CAF fixture builder =====

function buildCAF({ sampleRate, formatID, formatFlags, bitsPerChannel, channelsPerFrame, samples }) {
	let bytesPerSample = (formatID === 'alaw' || formatID === 'ulaw') ? 1 : bitsPerChannel >> 3
	let bytesPerPacket = bytesPerSample * channelsPerFrame
	let framesPerPacket = 1

	// desc chunk: 32 bytes
	let descData = new ArrayBuffer(32)
	let descDV = new DataView(descData)
	descDV.setFloat64(0, sampleRate, false)
	let fid = formatID
	new Uint8Array(descData, 8, 4).set([fid.charCodeAt(0), fid.charCodeAt(1), fid.charCodeAt(2), fid.charCodeAt(3)])
	descDV.setUint32(12, formatFlags, false)
	descDV.setUint32(16, bytesPerPacket, false)
	descDV.setUint32(20, framesPerPacket, false)
	descDV.setUint32(24, channelsPerFrame, false)
	descDV.setUint32(28, bitsPerChannel, false)

	// audio data
	let framesCount = samples[0].length
	let audioLen = framesCount * bytesPerPacket
	let audioBuf = new ArrayBuffer(audioLen)
	let audioDV = new DataView(audioBuf)
	let audioU8 = new Uint8Array(audioBuf)
	let isFloat = formatFlags & 1, isLE = formatFlags & 2

	if (formatID === 'alaw') {
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < channelsPerFrame; c++, off++)
				audioU8[off] = alawEncode(samples[c][i])
	} else if (formatID === 'ulaw') {
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < channelsPerFrame; c++, off++)
				audioU8[off] = ulawEncode(samples[c][i])
	} else if (isFloat && bitsPerChannel === 32) {
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < channelsPerFrame; c++, off += 4)
				audioDV.setFloat32(off, samples[c][i], !!isLE)
	} else if (isFloat && bitsPerChannel === 64) {
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < channelsPerFrame; c++, off += 8)
				audioDV.setFloat64(off, samples[c][i], !!isLE)
	} else if (bitsPerChannel === 16) {
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < channelsPerFrame; c++, off += 2)
				audioDV.setInt16(off, Math.round(samples[c][i] * 32767), !!isLE)
	} else if (bitsPerChannel === 24) {
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < channelsPerFrame; c++, off += 3) {
				let s = Math.round(samples[c][i] * 8388607)
				if (!isLE) { audioU8[off] = (s >> 16) & 0xFF; audioU8[off + 1] = (s >> 8) & 0xFF; audioU8[off + 2] = s & 0xFF }
				else { audioU8[off] = s & 0xFF; audioU8[off + 1] = (s >> 8) & 0xFF; audioU8[off + 2] = (s >> 16) & 0xFF }
			}
	} else if (bitsPerChannel === 32) {
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < channelsPerFrame; c++, off += 4)
				audioDV.setInt32(off, Math.round(samples[c][i] * 2147483647), !!isLE)
	} else if (bitsPerChannel === 8) {
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < channelsPerFrame; c++, off++)
				audioDV.setInt8(off, Math.round(samples[c][i] * 127))
	}

	// data chunk: 4-byte editCount + audio
	let dataPayloadLen = 4 + audioLen

	// assemble: file header(8) + desc chunk(12+32) + data chunk(12+dataPayloadLen)
	let totalLen = 8 + 12 + 32 + 12 + dataPayloadLen
	let out = new Uint8Array(totalLen)
	let oDV = new DataView(out.buffer)
	let pos = 0

	// file header: 'caff' + version(1) + flags(0)
	out.set([0x63, 0x61, 0x66, 0x66], 0)
	oDV.setUint16(4, 1, false)
	oDV.setUint16(6, 0, false)
	pos = 8

	// desc chunk header
	out.set([0x64, 0x65, 0x73, 0x63], pos)  // 'desc'
	oDV.setUint32(pos + 4, 0, false)
	oDV.setUint32(pos + 8, 32, false)
	pos += 12
	out.set(new Uint8Array(descData), pos)
	pos += 32

	// data chunk header
	out.set([0x64, 0x61, 0x74, 0x61], pos)  // 'data'
	oDV.setUint32(pos + 4, 0, false)
	oDV.setUint32(pos + 8, dataPayloadLen, false)
	pos += 12
	// editCount = 0
	oDV.setUint32(pos, 0, false)
	pos += 4
	out.set(new Uint8Array(audioBuf), pos)

	return out
}

// Build CAF with -1 data chunk size
function buildCAFUnknownSize(opts) {
	let normal = buildCAF(opts)
	let dv = new DataView(normal.buffer)
	// find data chunk — it's after file header(8) + desc chunk(12+32) = 52
	let dataChunkOff = 52
	// set size to -1 (0xFFFFFFFFFFFFFFFF)
	dv.setUint32(dataChunkOff + 4, 0xFFFFFFFF, false)
	dv.setUint32(dataChunkOff + 8, 0xFFFFFFFF, false)
	return normal
}

// A-law encoder (for test fixture generation)
function alawEncode(linear) {
	let pcm = Math.round(linear * 32768)
	let sign = 0
	if (pcm < 0) { sign = 0x80; pcm = -pcm }
	if (pcm > 32767) pcm = 32767
	let exp, mant
	if (pcm < 256) { exp = 0; mant = pcm >> 4 }
	else {
		exp = 1
		let tmp = pcm >> 5
		while (tmp > 1 && exp < 7) { exp++; tmp >>= 1 }
		mant = (pcm >> (exp + 3)) & 0x0F
	}
	return (sign | (exp << 4) | mant) ^ 0x55
}

// mu-law encoder (for test fixture generation)
function ulawEncode(linear) {
	let pcm = Math.round(linear * 32768)
	let sign = 0
	if (pcm < 0) { sign = 0x80; pcm = -pcm }
	if (pcm > 32635) pcm = 32635
	pcm += 33
	let exp = 0, tmp = pcm >> 6
	while (tmp > 0 && exp < 7) { exp++; tmp >>= 1 }
	let mant = (pcm >> (exp + 3)) & 0x0F
	return ~(sign | (exp << 4) | mant) & 0xFF
}

// Generate test tone
function sineTone(freq, sr, dur, amp = 0.8) {
	let n = Math.round(sr * dur)
	let out = new Float32Array(n)
	for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * freq * i / sr)
	return out
}

// ===== Tests =====

let tone440 = sineTone(440, 44100, 0.1)
let tone880 = sineTone(880, 44100, 0.1)

// ---- 16-bit LE stereo (most common macOS) ----
console.log('16-bit LE stereo')
{
	// formatFlags: LE(2) = 2
	let caf = buildCAF({ sampleRate: 44100, formatID: 'lpcm', formatFlags: 2, bitsPerChannel: 16, channelsPerFrame: 2, samples: [tone440, tone880] })
	let r = await decode(caf)
	ok(r.channelData.length === 2, '2 channels')
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(r.channelData[0].length === tone440.length, 'correct frame count')
	ok(near(r.channelData[0][0], 0, 0.001), 'first sample ~0')
	// verify sine: peak near 0.8
	let peak = 0
	for (let s of r.channelData[0]) peak = Math.max(peak, Math.abs(s))
	ok(near(peak, 0.8, 0.01), 'peak ~0.8')
	// channels differ
	let diff = 0
	for (let i = 0; i < 100; i++) diff += Math.abs(r.channelData[0][i] - r.channelData[1][i])
	ok(diff > 0.1, 'L/R channels differ')
}

// ---- 16-bit BE stereo ----
console.log('16-bit BE stereo')
{
	// formatFlags: 0 (BE is default)
	let caf = buildCAF({ sampleRate: 48000, formatID: 'lpcm', formatFlags: 0, bitsPerChannel: 16, channelsPerFrame: 2, samples: [sineTone(440, 48000, 0.1), sineTone(880, 48000, 0.1)] })
	let r = await decode(caf)
	ok(r.channelData.length === 2, '2 channels')
	ok(r.sampleRate === 48000, 'sampleRate 48000')
	let peak = 0
	for (let s of r.channelData[0]) peak = Math.max(peak, Math.abs(s))
	ok(near(peak, 0.8, 0.01), 'peak ~0.8')
}

// ---- 32-bit float LE mono ----
console.log('32-bit float LE mono')
{
	// formatFlags: float(1) + LE(2) = 3
	let caf = buildCAF({ sampleRate: 44100, formatID: 'lpcm', formatFlags: 3, bitsPerChannel: 32, channelsPerFrame: 1, samples: [tone440] })
	let r = await decode(caf)
	ok(r.channelData.length === 1, '1 channel')
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	// float32 should be exact
	let maxErr = 0
	for (let i = 0; i < tone440.length; i++) maxErr = Math.max(maxErr, Math.abs(r.channelData[0][i] - tone440[i]))
	ok(maxErr < 1e-6, 'float32 exact (err ' + maxErr.toExponential(2) + ')')
}

// ---- 32-bit float BE stereo ----
console.log('32-bit float BE stereo')
{
	// formatFlags: float(1) = 1 (BE is default)
	let caf = buildCAF({ sampleRate: 44100, formatID: 'lpcm', formatFlags: 1, bitsPerChannel: 32, channelsPerFrame: 2, samples: [tone440, tone880] })
	let r = await decode(caf)
	ok(r.channelData.length === 2, '2 channels')
	let maxErr = 0
	for (let i = 0; i < tone440.length; i++) maxErr = Math.max(maxErr, Math.abs(r.channelData[0][i] - tone440[i]))
	ok(maxErr < 1e-6, 'float32 BE exact')
}

// ---- 64-bit float BE ----
console.log('64-bit float BE mono')
{
	// formatFlags: float(1) = 1 (BE is default)
	let caf = buildCAF({ sampleRate: 96000, formatID: 'lpcm', formatFlags: 1, bitsPerChannel: 64, channelsPerFrame: 1, samples: [sineTone(1000, 96000, 0.05)] })
	let r = await decode(caf)
	ok(r.channelData.length === 1, '1 channel')
	ok(r.sampleRate === 96000, 'sampleRate 96000')
	ok(r.channelData[0].length > 0, 'has samples')
}

// ---- 64-bit float LE ----
console.log('64-bit float LE mono')
{
	// formatFlags: float(1) + LE(2) = 3
	let caf = buildCAF({ sampleRate: 44100, formatID: 'lpcm', formatFlags: 3, bitsPerChannel: 64, channelsPerFrame: 1, samples: [tone440] })
	let r = await decode(caf)
	ok(r.channelData.length === 1, '1 channel')
	// float64 -> float32 truncation, but original is float32 so should be exact
	let maxErr = 0
	for (let i = 0; i < tone440.length; i++) maxErr = Math.max(maxErr, Math.abs(r.channelData[0][i] - tone440[i]))
	ok(maxErr < 1e-6, 'float64 LE roundtrip exact')
}

// ---- 24-bit BE ----
console.log('24-bit BE mono')
{
	// formatFlags: 0 (BE is default)
	let caf = buildCAF({ sampleRate: 44100, formatID: 'lpcm', formatFlags: 0, bitsPerChannel: 24, channelsPerFrame: 1, samples: [tone440] })
	let r = await decode(caf)
	ok(r.channelData.length === 1, '1 channel')
	let peak = 0
	for (let s of r.channelData[0]) peak = Math.max(peak, Math.abs(s))
	ok(near(peak, 0.8, 0.01), 'peak ~0.8')
}

// ---- 24-bit LE stereo ----
console.log('24-bit LE stereo')
{
	// formatFlags: LE(2) = 2
	let caf = buildCAF({ sampleRate: 22050, formatID: 'lpcm', formatFlags: 2, bitsPerChannel: 24, channelsPerFrame: 2, samples: [sineTone(440, 22050, 0.1), sineTone(880, 22050, 0.1)] })
	let r = await decode(caf)
	ok(r.channelData.length === 2, '2 channels')
	ok(r.sampleRate === 22050, 'sampleRate 22050')
	let peak = 0
	for (let s of r.channelData[0]) peak = Math.max(peak, Math.abs(s))
	ok(near(peak, 0.8, 0.01), 'peak ~0.8')
}

// ---- 32-bit int LE ----
console.log('32-bit int LE mono')
{
	// formatFlags: LE(2) = 2
	let caf = buildCAF({ sampleRate: 44100, formatID: 'lpcm', formatFlags: 2, bitsPerChannel: 32, channelsPerFrame: 1, samples: [tone440] })
	let r = await decode(caf)
	ok(r.channelData.length === 1, '1 channel')
	let peak = 0
	for (let s of r.channelData[0]) peak = Math.max(peak, Math.abs(s))
	ok(near(peak, 0.8, 0.01), 'peak ~0.8')
}

// ---- 8-bit mono ----
console.log('8-bit mono')
{
	// formatFlags: 0 (endianness irrelevant for 8-bit)
	let caf = buildCAF({ sampleRate: 8000, formatID: 'lpcm', formatFlags: 0, bitsPerChannel: 8, channelsPerFrame: 1, samples: [sineTone(440, 8000, 0.1)] })
	let r = await decode(caf)
	ok(r.channelData.length === 1, '1 channel')
	ok(r.sampleRate === 8000, 'sampleRate 8000')
	let peak = 0
	for (let s of r.channelData[0]) peak = Math.max(peak, Math.abs(s))
	ok(near(peak, 0.8, 0.05), 'peak ~0.8 (8-bit quantization)')
}

// ---- A-law mono ----
console.log('A-law mono')
{
	let caf = buildCAF({ sampleRate: 8000, formatID: 'alaw', formatFlags: 0, bitsPerChannel: 8, channelsPerFrame: 1, samples: [sineTone(440, 8000, 0.1)] })
	let r = await decode(caf)
	ok(r.channelData.length === 1, '1 channel')
	ok(r.sampleRate === 8000, 'sampleRate 8000')
	ok(r.channelData[0].length > 0, 'has samples')
	// a-law encode/decode roundtrip has some loss, verify signal exists
	let peak = 0
	for (let s of r.channelData[0]) peak = Math.max(peak, Math.abs(s))
	ok(peak > 0.1, 'has audio content')
}

// ---- mu-law stereo ----
console.log('mu-law stereo')
{
	let caf = buildCAF({ sampleRate: 8000, formatID: 'ulaw', formatFlags: 0, bitsPerChannel: 8, channelsPerFrame: 2, samples: [sineTone(440, 8000, 0.1), sineTone(880, 8000, 0.1)] })
	let r = await decode(caf)
	ok(r.channelData.length === 2, '2 channels')
	ok(r.sampleRate === 8000, 'sampleRate 8000')
	let peak = 0
	for (let s of r.channelData[0]) peak = Math.max(peak, Math.abs(s))
	ok(peak > 0.1, 'has audio content')
	// channels differ
	let diff = 0
	for (let i = 0; i < 50; i++) diff += Math.abs(r.channelData[0][i] - r.channelData[1][i])
	ok(diff > 0.01, 'L/R differ')
}

// ---- data chunk with -1 size ----
console.log('data chunk -1 size')
{
	let caf = buildCAFUnknownSize({ sampleRate: 44100, formatID: 'lpcm', formatFlags: 2, bitsPerChannel: 16, channelsPerFrame: 1, samples: [tone440] })
	let r = await decode(caf)
	ok(r.channelData.length === 1, '1 channel')
	ok(r.channelData[0].length === tone440.length, 'correct frame count')
}

// ---- Trailing chunks after data (#47 class) — must not be read as audio ----
console.log('trailing chunk after data')
{
	let caf = buildCAF({ sampleRate: 44100, formatID: 'lpcm', formatFlags: 2, bitsPerChannel: 16, channelsPerFrame: 1, samples: [tone440] })
	// append a 'free' chunk (12-byte header + 40-byte payload) after the data chunk
	let junkLen = 40
	let withJunk = new Uint8Array(caf.length + 12 + junkLen)
	withJunk.set(caf)
	let dv = new DataView(withJunk.buffer)
	let p = caf.length
	withJunk.set([0x66, 0x72, 0x65, 0x65], p) // 'free'
	dv.setUint32(p + 4, 0, false); dv.setUint32(p + 8, junkLen, false)
	let r = await decode(withJunk)
	ok(r.channelData[0].length === tone440.length, 'frames capped to data size (no trailing junk)')
}

// ---- Lifecycle ----
console.log('lifecycle')
{
	let caf = buildCAF({ sampleRate: 44100, formatID: 'lpcm', formatFlags: 2, bitsPerChannel: 16, channelsPerFrame: 1, samples: [tone440] })

	// decode after free throws
	let d = await decoder()
	d.free()
	let threw = false
	try { d.decode(caf) } catch { threw = true }
	ok(threw, 'decode after free throws')

	// double free is safe
	d = await decoder()
	d.decode(caf)
	d.free()
	d.free()
	ok(true, 'double free ok')

	// flush returns EMPTY
	d = await decoder()
	d.decode(caf)
	let f = d.flush()
	ok(f.channelData.length === 0, 'flush returns EMPTY')
	ok(f.sampleRate === 0, 'flush sampleRate 0')
	d.free()
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

	// undefined input
	d = await decoder()
	r = d.decode(undefined)
	ok(r.channelData.length === 0, 'undefined input -> EMPTY')
	d.free()

	// garbage data
	d = await decoder()
	let garbage = new Uint8Array(1000)
	crypto.getRandomValues(garbage)
	try {
		r = d.decode(garbage)
		ok(false, 'garbage should throw')
	} catch {
		ok(true, 'garbage -> threw')
	}
	d.free()

	// truncated CAF (valid magic, header only) — streaming decoder buffers, awaiting more
	d = await decoder()
	let truncated = new Uint8Array([0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0])
	r = d.decode(truncated)
	ok(r.channelData.length === 0, 'truncated header -> EMPTY (buffered)')
	d.free()

	// too short
	d = await decoder()
	r = d.decode(new Uint8Array(4))
	ok(r.channelData.length === 0, 'too short -> EMPTY')
	d.free()

	// ArrayBuffer input
	let caf = buildCAF({ sampleRate: 44100, formatID: 'lpcm', formatFlags: 3, bitsPerChannel: 32, channelsPerFrame: 1, samples: [tone440] })
	r = await decode(caf.buffer)
	ok(r.channelData.length === 1, 'ArrayBuffer input works')
}

// ---- Determinism ----
console.log('determinism')
{
	let caf = buildCAF({ sampleRate: 44100, formatID: 'lpcm', formatFlags: 2, bitsPerChannel: 16, channelsPerFrame: 2, samples: [tone440, tone880] })
	let r1 = await decode(caf)
	let r2 = await decode(caf)
	ok(r1.channelData[0].length === r2.channelData[0].length, 'same length')
	ok(r1.sampleRate === r2.sampleRate, 'same sampleRate')
	let maxDiff = 0
	for (let i = 0; i < r1.channelData[0].length; i++)
		maxDiff = Math.max(maxDiff, Math.abs(r1.channelData[0][i] - r2.channelData[0][i]))
	ok(maxDiff === 0, 'identical output')
}

// ---- No NaN/Inf ----
console.log('no NaN/Inf')
{
	let caf = buildCAF({ sampleRate: 44100, formatID: 'lpcm', formatFlags: 1, bitsPerChannel: 32, channelsPerFrame: 2, samples: [tone440, tone880] })
	let r = await decode(caf)
	let bad = 0
	for (let ch of r.channelData) for (let i = 0; i < ch.length; i++) if (!isFinite(ch[i])) bad++
	ok(bad === 0, 'no NaN/Inf in output')
}

// ---- Sequential determinism ----
console.log('sequential determinism')
{
	let caf16 = buildCAF({ sampleRate: 44100, formatID: 'lpcm', formatFlags: 2, bitsPerChannel: 16, channelsPerFrame: 1, samples: [tone440] })
	let cafAlaw = buildCAF({ sampleRate: 8000, formatID: 'alaw', formatFlags: 0, bitsPerChannel: 8, channelsPerFrame: 1, samples: [sineTone(440, 8000, 0.1)] })
	let cafFloat = buildCAF({ sampleRate: 44100, formatID: 'lpcm', formatFlags: 3, bitsPerChannel: 32, channelsPerFrame: 2, samples: [tone440, tone880] })

	let a1 = await decode(caf16), a2 = await decode(caf16)
	let b1 = await decode(cafAlaw), b2 = await decode(cafAlaw)
	let c1 = await decode(cafFloat), c2 = await decode(cafFloat)

	let exact16 = true, exactAlaw = true, exactFloat = true
	for (let i = 0; i < a1.channelData[0].length; i++) if (a1.channelData[0][i] !== a2.channelData[0][i]) { exact16 = false; break }
	for (let i = 0; i < b1.channelData[0].length; i++) if (b1.channelData[0][i] !== b2.channelData[0][i]) { exactAlaw = false; break }
	for (let ch = 0; ch < 2; ch++) for (let i = 0; i < c1.channelData[ch].length; i++) if (c1.channelData[ch][i] !== c2.channelData[ch][i]) { exactFloat = false; break }

	ok(exact16, '16-bit sequential bit-exact')
	ok(exactAlaw, 'alaw sequential bit-exact')
	ok(exactFloat, 'float32 sequential bit-exact')
}

// ---- Concurrent decoders ----
console.log('concurrent decoders')
{
	let cafA = buildCAF({ sampleRate: 44100, formatID: 'lpcm', formatFlags: 2, bitsPerChannel: 16, channelsPerFrame: 1, samples: [tone440] })
	let cafB = buildCAF({ sampleRate: 48000, formatID: 'lpcm', formatFlags: 0, bitsPerChannel: 16, channelsPerFrame: 2, samples: [sineTone(440, 48000, 0.1), sineTone(880, 48000, 0.1)] })
	let cafC = buildCAF({ sampleRate: 8000, formatID: 'ulaw', formatFlags: 0, bitsPerChannel: 8, channelsPerFrame: 1, samples: [sineTone(440, 8000, 0.1)] })
	let cafD = buildCAF({ sampleRate: 44100, formatID: 'lpcm', formatFlags: 3, bitsPerChannel: 32, channelsPerFrame: 1, samples: [tone440] })

	let [rA, rB, rC, rD] = await Promise.all([decode(cafA), decode(cafB), decode(cafC), decode(cafD)])
	ok(rA.channelData.length === 1 && rA.sampleRate === 44100, 'concurrent A ok')
	ok(rB.channelData.length === 2 && rB.sampleRate === 48000, 'concurrent B ok')
	ok(rC.channelData.length === 1 && rC.sampleRate === 8000, 'concurrent C ok')
	ok(rD.channelData.length === 1 && rD.sampleRate === 44100, 'concurrent D ok')

	// verify concurrent results match sequential
	let seqA = await decode(cafA)
	let matchA = true
	for (let i = 0; i < rA.channelData[0].length; i++) if (rA.channelData[0][i] !== seqA.channelData[0][i]) { matchA = false; break }
	ok(matchA, 'concurrent matches sequential')
}

// ---- Performance benchmark ----
console.log('performance benchmark')
{
	let longTone = sineTone(440, 44100, 1)
	let caf = buildCAF({ sampleRate: 44100, formatID: 'lpcm', formatFlags: 2, bitsPerChannel: 16, channelsPerFrame: 1, samples: [longTone] })
	let iters = 100
	let t0 = performance.now()
	for (let i = 0; i < iters; i++) await decode(caf)
	let elapsed = performance.now() - t0
	let perIter = elapsed / iters
	console.log(`  ${iters} decodes of 1s/44.1k/16bit in ${elapsed.toFixed(1)}ms (${perIter.toFixed(2)}ms/iter)`)
	ok(perIter < 50, 'decode < 50ms per 1s of audio')
}

// ---- Real file: 16-bit LE PCM ----
console.log('real file: 16-bit LE PCM')
{
	let caf = readFileSync(new URL('lena.caf', import.meta.resolve('audio-lena')))
	let r = await decode(caf)
	ok(r.channelData.length === 1, 'mono')
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(near(r.channelData[0].length / r.sampleRate, 12.27, 0.1), 'duration ~12.27s')
	ok(rms(r.channelData[0]) > 0.05, 'has audio content')
	let bad = 0
	for (let ch of r.channelData) for (let i = 0; i < ch.length; i++) if (!isFinite(ch[i])) bad++
	ok(bad === 0, 'no NaN/Inf')
}

// ---- Real file: 32-bit float ----
console.log('real file: 32-bit float')
{
	let caf = readFileSync(new URL('lena-f32.caf', import.meta.resolve('audio-lena')))
	let r = await decode(caf)
	ok(r.channelData.length === 1, 'mono')
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(near(r.channelData[0].length / r.sampleRate, 12.27, 0.1), 'duration ~12.27s')
	ok(rms(r.channelData[0]) > 0.05, 'has audio content')
}

// ---- Real file: A-law ----
console.log('real file: alaw')
{
	let caf = readFileSync(new URL('lena-alaw.caf', import.meta.resolve('audio-lena')))
	let r = await decode(caf)
	ok(r.channelData.length >= 1, 'has channels')
	ok(r.sampleRate === 8000, 'sampleRate 8000')
	ok(rms(r.channelData[0]) > 0.01, 'has audio content')
}

// ---- Performance (real file) ----
console.log('performance (real file)')
{
	let caf = readFileSync(new URL('lena.caf', import.meta.resolve('audio-lena')))
	await decode(caf)
	let t0 = performance.now(), N = 20
	for (let i = 0; i < N; i++) await decode(caf)
	let ms = (performance.now() - t0) / N
	ok(ms < 100, 'real file decode < 100ms (' + ms.toFixed(1) + 'ms)')
	console.log('  ' + ms.toFixed(1) + 'ms/decode (1MB, 12.3s audio)')
}

// ---- IMA4 ADPCM (Apple afconvert fixtures, 440/660Hz sines) ----
console.log('IMA4 ADPCM')
{
	let sine = (n, f, sr = 44100) => Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * f * i / sr))
	let corr = (a, b) => {
		let n = Math.min(a.length, b.length), sa = 0, sb = 0, sab = 0
		for (let i = 0; i < n; i++) { sa += a[i] * a[i]; sb += b[i] * b[i]; sab += a[i] * b[i] }
		return sab / Math.sqrt(sa * sb)
	}
	for (let name of ['ima4_mono', 'ima4_stereo']) {
		let buf = new Uint8Array(readFileSync(new URL('./fixtures/' + name + '.caf', import.meta.url)))
		let nCh = name.includes('stereo') ? 2 : 1
		let r = await decode(buf)
		let win = 20000 // inside the 22050-sample source (last packet is padded)
		ok(r.sampleRate === 44100, name + ': sampleRate 44100')
		ok(r.channelData.length === nCh, name + ': ' + nCh + 'ch')
		ok(corr(r.channelData[0].subarray(0, win), sine(win, 440)) > 0.99, name + ': ch0 ≈ 440Hz')
		if (nCh === 2) ok(corr(r.channelData[1].subarray(0, win), sine(win, 660)) > 0.99, name + ': ch1 ≈ 660Hz')

		// streaming with tiny chunks must match whole-file (cross-packet predictor carry)
		let dec = await decoder(), parts = [], total = 0
		for (let o = 0; o < buf.length; o += 100) { let p = dec.decode(buf.subarray(o, o + 100)); if (p.channelData.length) { parts.push(p); total += p.channelData[0].length } }
		dec.free()
		let merged = new Float32Array(total), off = 0
		for (let p of parts) { merged.set(p.channelData[0], off); off += p.channelData[0].length }
		let exact = merged.every((x, i) => x === r.channelData[0][i])
		ok(exact, name + ': 100-byte chunked stream == whole-file')
	}
}

console.log(`\n${pass + fail} tests, ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
