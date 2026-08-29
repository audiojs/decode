/**
 * TTA (True Audio) decoder — pure JS / ESM.
 *
 * TTA1 container: 22-byte header (format, channels, bps, sample rate, sample count, CRC32),
 * a seek table (per-frame byte length + CRC32), then CRC32-checked frames of
 * floor(sampleRate*256/245) samples each. Per channel, per sample: two-state adaptive Rice
 * coding (k0/k1 with sum/threshold adaptation) feeds an 8-tap sign-sign-LMS "hybrid" filter,
 * then a fixed first-order predictor; the last channel is then decorrelated against the rest
 * by a cascading half-sum/difference (mid/side style, generalized to N channels).
 *
 * Written from the TTA1 format and the BSD-licensed reference decoder — Alexander Djourik,
 * Pavel Zhilin, True Audio Software (2004): ttadec.c / filter.h / ttadec.h / ttalib.h, via the
 * Rockbox libtta port which retains the original license — see LICENSE.ttadec and README.
 * Cross-checked (read-only, not copied) against ffmpeg's libavcodec/tta.c (LGPL) for the exact
 * container/bitstream conventions ffmpeg's own `-c:a tta` encoder emits, since bit-exactness
 * against ffmpeg's decode is this package's correctness bar.
 *
 * let { channelData, sampleRate } = decode(ttaBytes)
 * let dec = decoder(); let r = dec.decode(chunk); dec.flush(); dec.free()
 */

const EMPTY = Object.freeze({ channelData: [], sampleRate: 0 })

// ---- CRC32 (IEEE 802.3 / zlib variant: poly 0xEDB88320, init/xorout 0xFFFFFFFF) ----

const CRC_TABLE = (() => {
	let t = new Uint32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
		t[n] = c >>> 0
	}
	return t
})()

function crc32(buf, start = 0, end = buf.length) {
	let crc = 0xFFFFFFFF
	for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
	return (crc ^ 0xFFFFFFFF) >>> 0
}

// ---- LSB-first bit reader (TTA packs bits into bytes starting from bit 0) ----

function makeBits(buf) {
	let pos = 0, cache = 0, n = 0
	function fill() { cache = (cache | (buf[pos++] << n)) >>> 0; n += 8 }
	function bit() { if (!n) fill(); let b = cache & 1; cache >>>= 1; n--; return b }
	function unary() { let c = 0; while (bit()) c++; return c }
	function read(k) {
		if (!k) return 0
		while (n < k) fill()
		let mask = k === 32 ? 0xFFFFFFFF : (1 << k) - 1
		let v = (cache & mask) >>> 0
		cache = (cache >>> k) >>> 0
		n -= k
		return v
	}
	return { unary, read }
}

// ---- adaptive Rice code tables (ff_tta_shift_1 / ff_tta_shift_16 in the reference: powers
// of two 2^0..2^31, then a saturating tail so k can never index past the table) ----

const SHIFT1 = new Uint32Array(41)
for (let i = 0; i < 32; i++) SHIFT1[i] = (1 << i) >>> 0
for (let i = 32; i < 40; i++) SHIFT1[i] = 0x80000000
SHIFT1[40] = 0xFFFFFFFF
const SHIFT16 = SHIFT1.subarray(4)

// filter shift by byte size (1/2/3 = 8/16/24-bit): flt_set in the reference
const FILTER_SHIFT = [10, 9, 10]

function initChannel(shift) {
	return {
		qm: new Int32Array(8), dx: new Int32Array(8), dl: new Int32Array(8),
		error: 0, shift, round: 1 << (shift - 1),
		k0: 10, k1: 10, sum0: SHIFT16[10], sum1: SHIFT16[10],
		predictor: 0,
	}
}

// 8-tap adaptive "hybrid" filter: sign-sign LMS on qm, driven by the sign of the previous
// prediction error; dl holds a running 2nd/3rd-order difference of past filtered samples.
function hybridFilter(ch, value) {
	let { qm, dx, dl } = ch
	if (ch.error < 0) for (let i = 0; i < 8; i++) qm[i] -= dx[i]
	else if (ch.error > 0) for (let i = 0; i < 8; i++) qm[i] += dx[i]

	let sum = ch.round
	for (let i = 0; i < 8; i++) sum = (sum + Math.imul(dl[i], qm[i])) | 0

	dx[0] = dx[1]; dx[1] = dx[2]; dx[2] = dx[3]; dx[3] = dx[4]
	dl[0] = dl[1]; dl[1] = dl[2]; dl[2] = dl[3]; dl[3] = dl[4]

	dx[4] = (dl[4] >> 30) | 1
	dx[5] = ((dl[5] >> 30) | 2) & ~1
	dx[6] = ((dl[6] >> 30) | 2) & ~1
	dx[7] = ((dl[7] >> 30) | 4) & ~3

	ch.error = value
	value = (value + (sum >> ch.shift)) | 0

	dl[4] = -dl[5]
	dl[5] = -dl[6]
	dl[6] = value - dl[7]
	dl[7] = value
	dl[5] += dl[6]
	dl[4] += dl[5]

	return value
}

// one sample: adaptive-Rice decode -> sign unfold -> hybrid filter -> order-1 predictor
function decodeValue(br, ch, predShift) {
	let unary = br.unary(), depth, k
	if (unary === 0) { depth = 0; k = ch.k0 }
	else { depth = 1; k = ch.k1; unary-- }
	let value = k ? (unary << k) + br.read(k) : unary

	if (depth === 1) {
		ch.sum1 = (ch.sum1 + value - (ch.sum1 >>> 4)) >>> 0
		if (ch.k1 > 0 && ch.sum1 < SHIFT16[ch.k1]) ch.k1--
		else if (ch.sum1 > SHIFT16[ch.k1 + 1]) ch.k1++
		value += SHIFT1[ch.k0]
	}
	ch.sum0 = (ch.sum0 + value - (ch.sum0 >>> 4)) >>> 0
	if (ch.k0 > 0 && ch.sum0 < SHIFT16[ch.k0]) ch.k0--
	else if (ch.sum0 > SHIFT16[ch.k0 + 1]) ch.k0++

	value = (value & 1) ? (value + 1) >> 1 : -(value >> 1) // zigzag unfold

	value = hybridFilter(ch, value)

	let p = ch.predictor
	value = (value + (((p << predShift) - p) >> predShift)) | 0
	ch.predictor = value

	return value
}

function scale(v, byteSize) {
	if (byteSize === 1) return v < 0 ? v / 128 : v / 127
	if (byteSize === 2) return v < 0 ? v / 32768 : v / 32767
	return v < 0 ? v / 8388608 : v / 8388607 // 24-bit
}

// decode exactly one frame's payload (including its trailing 4-byte CRC32); null on CRC fail
function decodeFrame(bytes, hdr, nSamples) {
	let n = bytes.length
	if (n < 4 || crc32(bytes, 0, n - 4) !== readU32(bytes, n - 4)) return null

	let { channels, byteSize, filterShift, predShift } = hdr
	let chans = new Array(channels)
	for (let c = 0; c < channels; c++) chans[c] = initChannel(filterShift)

	let out = new Array(channels)
	for (let c = 0; c < channels; c++) out[c] = new Float32Array(nSamples)

	let br = makeBits(bytes), raw = new Int32Array(channels)
	for (let s = 0; s < nSamples; s++) {
		for (let c = 0; c < channels; c++) raw[c] = decodeValue(br, chans[c], predShift)
		if (channels > 1) {
			// decorrelate: last channel gets a half-sum with its neighbor, then a cascading
			// difference chain runs the correction back down to channel 0 (mid/side, N-ary)
			raw[channels - 1] = (raw[channels - 1] + ((raw[channels - 2] / 2) | 0)) | 0
			for (let c = channels - 2; c >= 0; c--) raw[c] = (raw[c + 1] - raw[c]) | 0
		}
		for (let c = 0; c < channels; c++) out[c][s] = scale(raw[c], byteSize)
	}
	return out
}

// ---- container: header, seek table, ID3v2 skip, CRC32 ----

function readU16(b, o) { return b[o] | (b[o + 1] << 8) }
function readU32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 }

// ID3v2 header: 'ID3' + version(2) + flags(1) + syncsafe size(4, 7 bits/byte); + 10 if a
// footer is flagged (bit 4 of the flags byte).
function id3v2Size(b) {
	let size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f)
	return 10 + size + ((b[5] & 0x10) ? 10 : 0)
}

function parseHeader(b, off) {
	let format = readU16(b, off + 4)
	let channels = readU16(b, off + 6)
	let bitsPerSample = readU16(b, off + 8)
	let sampleRate = readU32(b, off + 10)
	let dataLength = readU32(b, off + 14)
	let crc = readU32(b, off + 18)
	if (crc32(b, off, off + 18) !== crc) throw Error('TTA: header CRC mismatch')
	if (format !== 1) throw Error('TTA: unsupported format ' + format + ' (only PCM streams are decoded)')
	if (!channels || channels > 16) throw Error('TTA: invalid channel count ' + channels)
	let byteSize = Math.ceil(bitsPerSample / 8)
	if (byteSize < 1 || byteSize > 3) throw Error('TTA: unsupported bit depth ' + bitsPerSample + ' (8/16/24-bit only)')
	if (!(sampleRate > 0 && sampleRate <= 0x7FFFFF)) throw Error('TTA: invalid sample rate ' + sampleRate)

	let frameLen = Math.floor(sampleRate * 256 / 245) // FRAME_TIME = 256/245 s, in samples
	let totalFrames, lastFrameLen
	if (dataLength === 0) { totalFrames = 0; lastFrameLen = 0 }
	else {
		lastFrameLen = (dataLength % frameLen) || frameLen
		totalFrames = Math.floor(dataLength / frameLen) + (lastFrameLen < frameLen ? 1 : 0)
	}
	if (totalFrames < 0 || totalFrames > 5_000_000) throw Error('TTA: implausible frame count ' + totalFrames)

	return {
		channels, bitsPerSample, byteSize, sampleRate, dataLength, frameLen, lastFrameLen, totalFrames,
		filterShift: FILTER_SHIFT[byteSize - 1], predShift: byteSize === 1 ? 4 : 5,
	}
}

function cat(a, b) {
	let r = new Uint8Array(a.length + b.length)
	r.set(a); r.set(b, a.length)
	return r
}

function merge(parts, hdr) {
	if (!parts.length) return EMPTY
	let total = parts.reduce((s, p) => s + p[0].length, 0)
	let channelData = Array.from({ length: hdr.channels }, (_, c) => {
		let o = new Float32Array(total), off = 0
		for (let p of parts) { o.set(p[c], off); off += p[c].length }
		return o
	})
	return { channelData, sampleRate: hdr.sampleRate }
}

/** Create a synchronous streaming decoder. */
export function decoder() {
	let skip = null       // bytes of a leading ID3v2 tag to drop, once known
	let hdr = null         // parsed TTA1 header, once complete
	let frameSizes = null  // per-frame byte length, from the seek table
	let frameIdx = 0
	let left = null        // carried-over incomplete header/seektable/frame bytes
	let freed = false
	let errors = 0          // frames dropped for a CRC32 mismatch

	function decode(data) {
		if (freed) throw Error('Decoder already freed')
		if (!data || !data.byteLength) return EMPTY
		let chunk = data instanceof Uint8Array ? data : new Uint8Array(data)
		if (left) { chunk = cat(left, chunk); left = null }

		if (!hdr) {
			if (skip === null) {
				if (chunk.length < 3) { left = chunk.slice(); return EMPTY }
				if (chunk[0] === 0x49 && chunk[1] === 0x44 && chunk[2] === 0x33) { // 'ID3'
					if (chunk.length < 10) { left = chunk.slice(); return EMPTY }
					skip = id3v2Size(chunk)
				} else skip = 0
			}
			if (chunk.length < skip + 4) { left = chunk.slice(); return EMPTY }
			if (!(chunk[skip] === 0x54 && chunk[skip + 1] === 0x54 && chunk[skip + 2] === 0x41 && chunk[skip + 3] === 0x31))
				throw TypeError('Not a TTA file')
			if (chunk.length < skip + 22) { left = chunk.slice(); return EMPTY }
			hdr = parseHeader(chunk, skip)
			chunk = chunk.subarray(skip + 22)
		}

		if (!frameSizes) {
			let need = hdr.totalFrames * 4 + 4
			if (chunk.length < need) { left = chunk.slice(); return EMPTY }
			let sizes = new Uint32Array(hdr.totalFrames)
			for (let i = 0; i < hdr.totalFrames; i++) sizes[i] = readU32(chunk, i * 4)
			if (crc32(chunk, 0, hdr.totalFrames * 4) !== readU32(chunk, hdr.totalFrames * 4))
				throw Error('TTA: seek-table CRC mismatch')
			frameSizes = sizes
			chunk = chunk.subarray(need)
		}

		let parts = []
		while (frameIdx < hdr.totalFrames) {
			let want = frameSizes[frameIdx]
			if (chunk.length < want) { left = chunk.slice(); return merge(parts, hdr) }
			let nSamples = frameIdx === hdr.totalFrames - 1 ? hdr.lastFrameLen : hdr.frameLen
			let out = decodeFrame(chunk.subarray(0, want), hdr, nSamples)
			if (out) parts.push(out); else errors++
			chunk = chunk.subarray(want)
			frameIdx++
		}
		return merge(parts, hdr)
	}

	return {
		decode,
		/** Drop any trailing incomplete header/seek-table/frame bytes. */
		flush() { left = null; return EMPTY },
		free() { freed = true; left = null },
		/** Frames dropped so far for a CRC32 mismatch. */
		get errors() { return errors },
	}
}

/** Decode a complete TTA stream synchronously. */
export default function decode(src) {
	let dec = decoder()
	try { return dec.decode(src instanceof Uint8Array ? src : new Uint8Array(src)) }
	finally { dec.free() }
}
