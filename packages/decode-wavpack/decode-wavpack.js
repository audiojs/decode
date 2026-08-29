/**
 * WavPack decoder — libwavpack compiled to WASM (single-file ES module, host-neutral).
 * Streaming: the memory-backed WavpackStreamReader64 in the C glue lets libwavpack's own block
 * reader drive decoding, so multichannel block groups, hybrid/lossy streams and DSD-as-PCM all
 * decode exactly as the reference library would. JS only tracks byte-level block boundaries
 * (the 32-byte block header's ckSize field) so it never hands the reader a partial block.
 *
 * let { channelData, sampleRate } = await decode(wvBuf)
 * let dec = await decoder(); let result = dec.decode(chunk)
 */
import createWavpack from './src/wavpack.wasm.js'

const EMPTY = Object.freeze({ channelData: [], sampleRate: 0 })
const EMPTY_BYTES = new Uint8Array(0)
const HEADER = 8            // bytes needed to read ckSize and know the full block size
const MAX_BLOCK = 16 << 20  // sanity cap: no real WavPack block approaches 16 MiB

let modP
function getMod() {
	if (modP) return modP
	let p = createWavpack()
	modP = p
	return p.catch(e => { modP = null; throw e })
}

/**
 * Whole-file decode
 * @param {Uint8Array|ArrayBuffer} src
 * @returns {Promise<{channelData: Float32Array[], sampleRate: number}>}
 */
export default async function decode(src) {
	let buf = src instanceof Uint8Array ? src : new Uint8Array(src)
	let dec = await decoder()
	try { return dec.decode(buf) }
	finally { dec.free() }
}

/** Create streaming decoder instance — decode() and flush() are synchronous. */
export async function decoder() {
	return new WavpackDecoder(await getMod())
}

class WavpackDecoder {
	constructor(m) {
		this.m = m
		this.h = m._wv_create()
		if (!this.h) throw Error('WavPack decoder allocation failed')
		this.left = EMPTY_BYTES
		this.sawBlock = false // true once at least one real block has been parsed (ever)
		this.freed = false
	}

	decode(data) {
		if (this.freed) throw Error('Decoder already freed')
		if (!data || !data.byteLength) return EMPTY
		let buf = data instanceof Uint8Array ? data : new Uint8Array(data)
		let joined = this.left.length ? concat(this.left, buf) : buf

		// Audio blocks are always contiguous from the start of the stream; anything after them
		// (APEv2 tags, padding) does not start with 'wvpk' and is inert trailer, not corruption —
		// only a magic/size mismatch before any real block has been seen is a hard error.
		let pos = 0, seen = this.sawBlock
		while (pos + HEADER <= joined.length) {
			let isWvpk = joined[pos] === 0x77 && joined[pos + 1] === 0x76 && joined[pos + 2] === 0x70 && joined[pos + 3] === 0x6B
			if (!isWvpk) {
				if (!seen) throw Error('WavPack: not a WavPack stream (missing "wvpk" sync)')
				break
			}
			let ckSize = (joined[pos + 4] | joined[pos + 5] << 8 | joined[pos + 6] << 16 | joined[pos + 7] << 24) >>> 0
			let blockLen = ckSize + 8
			if (blockLen < 32 || blockLen > MAX_BLOCK) {
				if (!seen) throw Error('WavPack: implausible block size (corrupt stream?)')
				break
			}
			if (pos + blockLen > joined.length) break // incomplete block — wait for more
			pos += blockLen
			seen = true
		}
		this.sawBlock = seen
		this.left = pos < joined.length ? joined.subarray(pos).slice() : EMPTY_BYTES
		if (!pos) return EMPTY

		let m = this.m
		let dst = m._wv_reserve(this.h, pos)
		if (!dst) throw Error('WavPack: out of WASM memory')
		m.HEAPU8.set(joined.subarray(0, pos), dst)
		let n = m._wv_feed(this.h, pos)
		if (n < 0) throw Error(readError(m, this.h))
		if (!n) return EMPTY

		let channels = m._wv_channels(this.h)
		let sampleRate = m._wv_rate(this.h)
		let bits = m._wv_bits(this.h)
		let isFloat = m._wv_is_float(this.h)
		let outPtr = m._wv_output(this.h)
		let channelData = Array.from({ length: channels }, () => new Float32Array(n))

		if (isFloat) {
			let f32 = new Float32Array(m.HEAPU8.buffer, outPtr, n * channels)
			for (let i = 0, k = 0; i < n; i++) for (let c = 0; c < channels; c++) channelData[c][i] = f32[k++]
		} else {
			let div = 2 ** (bits - 1), max = div - 1
			let base = outPtr >> 2, k = base
			let i32 = m.HEAP32
			for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) {
				let v = i32[k++]
				channelData[c][i] = v < 0 ? v / div : v / max
			}
		}
		return { channelData, sampleRate }
	}

	/** No trailing latency: decode() already drains every sample libwavpack can produce from the
	    blocks fed so far. Drops an incomplete trailing block, if any. */
	flush() {
		this.left = EMPTY_BYTES
		return EMPTY
	}

	free() {
		if (this.freed) return
		this.freed = true
		this.m._wv_destroy(this.h)
		this.h = 0
		this.left = EMPTY_BYTES
	}
}

function concat(a, b) {
	let out = new Uint8Array(a.length + b.length)
	out.set(a); out.set(b, a.length)
	return out
}

function readError(m, h) {
	let ptr = m._wv_error(h)
	let bytes = m.HEAPU8.subarray(ptr, ptr + 128)
	let nul = bytes.indexOf(0)
	return new TextDecoder().decode(bytes.subarray(0, nul < 0 ? 128 : nul))
}
