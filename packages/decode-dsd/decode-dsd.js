/**
 * DSD → PCM decoder — pure JS
 * Decodes DSF (Sony DSD Stream File) and DFF (Philips DSDIFF) to Float32 PCM.
 *
 * DSD is a 1-bit-per-sample sigma-delta stream at 2.8224 MHz×2^n ("DSD64" and up). Converting it
 * to PCM is a low-pass + decimate: a windowed-sinc (Kaiser) FIR removes the shaped quantization
 * noise pushed above the audio band, then every Nth sample is kept.
 *
 * Stage 1 always decimates the raw bitstream ×8 (e.g. DSD64 → 352.8 kHz) using the classic
 * per-byte lookup-table trick: each DSD bit is ±1, so an 8-bit tap group against 8 filter taps has
 * only 256 possible partial sums — precompute them once (Sebastian Gesemann's dsd2pcm, BSD
 * license, https://github.com/sdaau/dsd2pcm; the same technique is in ffmpeg's libavcodec/dsd.c).
 * This implementation is written from scratch, not a port.
 * Stage 2 (when the requested ratio is > 8) is an ordinary decimating FIR on the float output of
 * stage 1 — cheap, since it now runs at 1/8th the raw bit rate.
 *
 * let { channelData, sampleRate } = decode(dsfOrDffBytes)
 */

const EMPTY = Object.freeze({ channelData: [], sampleRate: 0 })

// ---------------------------------------------------------------------------
// Bit-reversal (byte-level): DSF with bitsPerSample===1 stores each channel byte LSB-first
// (bit 0 = oldest sample); DFF and DSF with bitsPerSample===8 are MSB-first. The stage-1 engine
// below assumes MSB-first, so LSB-first bytes are run through this table on the way in.
const REV8 = new Uint8Array(256)
for (let i = 0; i < 256; i++) {
	let v = i, r = 0
	for (let b = 0; b < 8; b++) { r = (r << 1) | (v & 1); v >>= 1 }
	REV8[i] = r
}

// ---------------------------------------------------------------------------
// Kaiser-windowed-sinc FIR design — Kaiser (1966); formulas per Oppenheim & Schafer,
// "Discrete-Time Signal Processing" 3rd ed., §7.5.3 (Table 7.3 / eq. 7.75-7.76).

// Modified Bessel function I0(x), power series (converges fast for the |x| this uses, β ≤ ~20).
function besselI0(x) {
	let sum = 1, term = 1, k = 1
	const y = (x * x) / 4
	while (k < 64 && term > sum * 1e-16) { term *= y / (k * k); sum += term; k++ }
	return sum
}

// β from target stopband attenuation A (dB). Kaiser's empirical formula.
function kaiserBeta(A) {
	if (A > 50) return 0.1102 * (A - 8.71)
	if (A >= 21) return 0.5842 * Math.pow(A - 21, 0.4) + 0.07886 * (A - 21)
	return 0
}

// Filter length for transition width dw (rad/sample) at attenuation A (dB).
function kaiserLength(A, dw) {
	return Math.max(4, Math.ceil((A - 8) / (2.285 * dw)))
}

// Windowed-sinc lowpass, cutoff fc (Hz) at sample rate fs (Hz), N taps, Kaiser β. Unity DC gain.
// N may be even (no exact center sample — used for stage 1, matches the classic dsd2pcm layout)
// or odd (Type-I linear phase, single center tap — used for stage 2).
function designLowpass(fc, fs, N, beta) {
	const h = new Float64Array(N), M = (N - 1) / 2, wc = (2 * Math.PI * fc) / fs, i0b = besselI0(beta)
	let sum = 0
	for (let n = 0; n < N; n++) {
		const m = n - M
		const sinc = m === 0 ? wc / Math.PI : Math.sin(wc * m) / (Math.PI * m)
		const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - (m / M) ** 2))) / i0b
		h[n] = sinc * w
		sum += h[n]
	}
	for (let n = 0; n < N; n++) h[n] /= sum
	return h
}

// ---------------------------------------------------------------------------
// Stage 1: bit-domain LUT decimator, fixed ×8 (raw DSD bits → dsdRate/8 float PCM).
//
// Fixed default length/cutoff: N1=192 taps (HTAPS=96, CTABLES=12), cutoff 0.45×(dsdRate/8),
// target stopband 100 dB. At DSD64 (dsdRate=2 822 400 Hz) this gives an achieved transition width
// of about 95 kHz (β=kaiserBeta(100)≈10.06, computed from N1 via the length formula above),
// i.e. clean below ~159 kHz and re-suppressed by ~247 kHz — both far above the audio band, and
// (for ratio>8) further cleaned by stage 2's own passband, which sits far below stage 1's
// transition region. Override via opts.length/opts.cutoff/opts.stopband (applies when ratio===8,
// since stage 1 is then the only stage).
const STAGE1_TAPS = 192
const STOPBAND_DB = 100

function buildStage1(dsdRate, opts) {
	const outRate = dsdRate / 8
	const cutoff = (opts.cutoff ?? 0.45) * outRate
	const stopband = opts.stopband ?? STOPBAND_DB
	const N = (opts.length && opts.ratio === 8 ? opts.length : STAGE1_TAPS) | 0
	const evenN = N + (N & 1) // force even: no unpaired center tap (dsd2pcm-style symmetric halves)
	const beta = kaiserBeta(stopband)
	const h = designLowpass(cutoff, dsdRate, evenN, beta)
	const HTAPS = evenN / 2
	const half = h.subarray(HTAPS) // 2nd half of the symmetric filter, length HTAPS
	const CTABLES = Math.ceil(HTAPS / 8)
	const tables = Array.from({ length: CTABLES }, () => new Float32Array(256))
	const acc = new Float64Array(CTABLES)
	for (let byteVal = 0; byteVal < 256; byteVal++) {
		acc.fill(0)
		for (let bit = 0; bit < 8; bit++) {
			// MSB-first: bit 0 of the group = bit 7 of the byte = earliest sample in time.
			const sign = ((byteVal >> (7 - bit)) & 1) * 2 - 1
			for (let t = 0; t < CTABLES; t++) {
				const tapIdx = t * 8 + bit
				acc[t] += sign * (tapIdx < HTAPS ? half[tapIdx] : 0)
			}
		}
		for (let t = 0; t < CTABLES; t++) tables[CTABLES - 1 - t][byteVal] = acc[t]
	}
	return { CTABLES, tables, outRate, taps: evenN, cutoff, stopband }
}

// Per-channel bit-domain FIFO + convolution state. push(byte) → one Float64 PCM sample.
function makeStage1Channel(stage1) {
	const { CTABLES, tables } = stage1
	let size = 4
	while (size < CTABLES * 2) size <<= 1
	const MASK = size - 1
	const buf = new Uint8Array(size)
	let pos = 0
	return {
		push(byte) {
			buf[pos] = byte
			const p = (pos - CTABLES) & MASK
			buf[p] = REV8[buf[p]]
			let sum = 0
			for (let i = 0; i < CTABLES; i++) {
				const a = buf[(pos - i) & MASK]
				const b = buf[(pos - (CTABLES * 2 - 1) + i) & MASK]
				sum += tables[i][a] + tables[i][b]
			}
			pos = (pos + 1) & MASK
			return sum
		},
	}
}

// ---------------------------------------------------------------------------
// Stage 2: ordinary decimating FIR on stage 1's float output, only built when ratio > 8.
// Anti-alias-correct by construction: transition band runs from the passband edge to the
// mirror point of the decimation (outRate − cutoff), so no energy folds back into the passband
// regardless of what's above it — this stage is the last one, so it must hold on its own.
function buildStage2(rateIn, ratio, opts) {
	const outRate = rateIn / ratio
	const cutoff = (opts.cutoff ?? 0.45) * outRate
	const stopband = opts.stopband ?? STOPBAND_DB
	const df = outRate - 2 * cutoff // transition width to the alias-safe mirror point
	if (df <= 0) throw Error('cutoff too high for alias-free decimation (must be < 0.5× output rate)')
	const beta = kaiserBeta(stopband)
	let N = opts.length || kaiserLength(stopband, (2 * Math.PI * df) / rateIn)
	N += N & 1 // force even (symmetric halves, no unpaired center tap)
	const h = designLowpass(cutoff, rateIn, N, beta)
	return { h, N, outRate, cutoff, stopband }
}

// Per-channel streaming decimator: carries FIR history and global sample-phase across calls.
function makeStage2Channel(stage2, ratio) {
	const { h, N } = stage2
	const half = N / 2
	let hist = new Float64Array(N - 1) // zero-initialized: implicit silence pre-roll
	let pos = 0 // total stage-1 samples absorbed so far (persistent across calls)
	return {
		// input: Float64Array of new stage-1-rate samples. Returns Float32Array decimated output.
		push(input) {
			const total = hist.length + input.length
			const buf = new Float64Array(total)
			buf.set(hist)
			buf.set(input, hist.length)
			const globalStart = pos - hist.length
			// emit for every global index g ≡ (N-1) mod ratio, g >= N-1
			let j = (((N - 1 - globalStart) % ratio) + ratio) % ratio
			if (j < N - 1) j += ratio * Math.ceil((N - 1 - j) / ratio)
			const out = []
			for (; j < total; j += ratio) {
				let sum = 0
				const base = j - (N - 1)
				for (let n = 0; n < half; n++) sum += h[n] * (buf[base + n] + buf[j - n])
				out.push(sum)
			}
			hist = buf.subarray(total - (N - 1)).slice() // total is always >= N-1 since hist.length===N-1
			pos += input.length
			return Float32Array.from(out)
		},
	}
}

// ---------------------------------------------------------------------------
// Container parsing

function str4(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) }
function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 }
function u64le(b, o) { return u32le(b, o) + u32le(b, o + 4) * 0x100000000 }
function u32be(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0 }
function u64be(b, o) { return u32be(b, o) * 0x100000000 + u32be(b, o + 4) }
function u16be(b, o) { return (b[o] << 8) | b[o + 1] }

// Returns null if buf doesn't yet hold the whole fixed-size DSF header (92 bytes), else the
// parsed header + dataStart offset. Throws on structurally invalid input.
function scanDsfHeader(buf) {
	if (buf.length < 12) return null
	if (str4(buf, 0) !== 'DSD ') throw Error('Not a DSF file')
	if (buf.length < 28) return null
	if (u64le(buf, 4) !== 28) throw Error('Not a DSF file')
	const fileSize = u64le(buf, 12)
	const metaPointer = u64le(buf, 20)
	if (buf.length < 92) return null
	if (str4(buf, 28) !== 'fmt ') throw Error('Malformed DSF: missing fmt chunk')
	const fmtSize = u64le(buf, 32)
	if (fmtSize < 52) throw Error('Malformed DSF: fmt chunk too small')
	if (u32le(buf, 40) !== 1) throw Error('Unsupported DSF format version')
	if (u32le(buf, 44) !== 0) throw Error('Unsupported DSF format id (not raw DSD)')
	const channels = u32le(buf, 52) // channelNum is authoritative for buffer sizing; channelType (offset 48) is informational
	if (!channels) throw Error('Malformed DSF: zero channels')
	const dsdRate = u32le(buf, 56)
	const bitsPerSample = u32le(buf, 60)
	if (bitsPerSample !== 1 && bitsPerSample !== 8) throw Error('Unsupported DSF bits-per-sample: ' + bitsPerSample)
	const sampleCount = u64le(buf, 64)
	const blockSize = u32le(buf, 72)
	if (blockSize <= 0) throw Error('Malformed DSF: invalid block size')
	const dataHdr = 28 + fmtSize
	if (buf.length < dataHdr + 12) return null
	if (str4(buf, dataHdr) !== 'data') throw Error('Malformed DSF: missing data chunk')
	const dataChunkSize = u64le(buf, dataHdr + 4)
	const dataStart = dataHdr + 12
	const dataSize = Math.max(0, dataChunkSize - 12)
	return { container: 'dsf', dsdRate, channels, bitsPerSample, sampleCount, blockSize, dataStart, dataSize, fileSize, metaPointer }
}

// IFF-style local chunk header reader: {id, size, bodyStart} or null if not enough bytes.
function readChunkHdr(buf, off) {
	if (off + 12 > buf.length) return null
	return { id: str4(buf, off), size: u64be(buf, off + 4), bodyStart: off + 12 }
}

// Returns null if the DFF header (FRM8/FVER/PROP + enough to find the DSD chunk) isn't fully
// buffered yet, else the parsed header + dataStart offset. Throws on DST compression or bad magic.
function scanDffHeader(buf) {
	if (buf.length < 16) return null
	if (str4(buf, 0) !== 'FRM8') throw Error('Not a DFF file')
	if (str4(buf, 12) !== 'DSD ') throw Error('Not a DFF file')
	let off = 16, dsdRate = 0, channels = 0, chanIds = [], sawFver = false, sawProp = false
	while (true) {
		const ck = readChunkHdr(buf, off)
		if (!ck) return null
		const bodyEnd = ck.bodyStart + ck.size
		const next = bodyEnd + (ck.size & 1) // pad to even
		if (ck.id === 'FVER') {
			if (bodyEnd > buf.length) return null
			sawFver = true
		} else if (ck.id === 'PROP') {
			if (ck.bodyStart + 4 > buf.length) return null
			if (str4(buf, ck.bodyStart) !== 'SND ') throw Error('Unsupported DFF property type')
			let p = ck.bodyStart + 4
			while (p < bodyEnd) {
				const sub = readChunkHdr(buf, p)
				if (!sub) return null
				const subEnd = sub.bodyStart + sub.size
				if (subEnd > buf.length) return null
				if (sub.id === 'FS  ') dsdRate = u32be(buf, sub.bodyStart)
				else if (sub.id === 'CHNL') {
					channels = u16be(buf, sub.bodyStart)
					chanIds = []
					for (let c = 0; c < channels; c++) chanIds.push(str4(buf, sub.bodyStart + 2 + c * 4))
				} else if (sub.id === 'CMPR') {
					const compType = str4(buf, sub.bodyStart)
					if (compType === 'DST ') throw Error('Unsupported: DST')
					if (compType !== 'DSD ') throw Error('Unsupported DFF compression: ' + compType)
				}
				p = subEnd + (sub.size & 1)
			}
			sawProp = true
		} else if (ck.id === 'DSD ') {
			if (!sawFver || !sawProp) throw Error('Malformed DFF: DSD chunk before FVER/PROP')
			if (!dsdRate || !channels) throw Error('Malformed DFF: missing FS or CHNL')
			return { container: 'dff', dsdRate, channels, chanIds, dataStart: ck.bodyStart, dataSize: ck.size }
		} else if (ck.id === 'DST ') {
			throw Error('Unsupported: DST')
		}
		// COMT, DIIN/DITI/DIAR/EMID/MARK, MANF, ABSS, LSCO (inside PROP, handled above) — skip.
		if (bodyEnd > buf.length) return null
		off = next
	}
}

// ---------------------------------------------------------------------------
// Streaming decoder

const VALID_RATIOS = [8, 16, 32, 64]

function catBytes(a, b) {
	const r = new Uint8Array(a.length + b.length)
	r.set(a); r.set(b, a.length)
	return r
}

/** Create a synchronous DSD (DSF/DFF) → PCM decoder. */
export function decoder(opts = {}) {
	let header = null, carry = null, freed = false
	let stage1 = null, stage1Ch = [], stage2 = null, stage2Ch = null, ratio = 8
	let dataConsumed = 0 // bytes of the *data region* consumed so far (post-header), all channels combined
	let finalEmitted = 0 // samples emitted per channel so far at the final rate (for DSF trimming)
	let finalLimit = Infinity // true sample count per channel at the final rate (DSF only)

	function setupFilters(h) {
		if (opts.sampleRate) {
			const r = Math.round(h.dsdRate / opts.sampleRate)
			if (!VALID_RATIOS.includes(r) || Math.abs(h.dsdRate / r - opts.sampleRate) > 1e-6)
				throw Error('Unsupported sampleRate: ' + opts.sampleRate + ' (dsdRate/8, /16, /32 or /64 only)')
			ratio = r
		} else ratio = opts.ratio && VALID_RATIOS.includes(opts.ratio) ? opts.ratio : 32
		stage1 = buildStage1(h.dsdRate, { ...opts, ratio })
		stage1Ch = Array.from({ length: h.channels }, () => makeStage1Channel(stage1))
		if (ratio > 8) {
			stage2 = buildStage2(stage1.outRate, ratio / 8, opts)
			stage2Ch = Array.from({ length: h.channels }, () => makeStage2Channel(stage2, ratio / 8))
		}
		if (h.container === 'dsf' && h.sampleCount) finalLimit = Math.floor(h.sampleCount / ratio)
	}

	// Run `bytes` (raw data-region bytes, already sliced to a whole multiple of the frame unit)
	// through stage 1 (+ stage 2) per channel, per the container's interleave layout.
	function decodeFrames(bytes) {
		const nCh = header.channels
		const outCh = []
		if (header.container === 'dsf') {
			const blockSize = header.blockSize, group = blockSize * nCh
			const groups = bytes.length / group
			for (let c = 0; c < nCh; c++) {
				const s1 = new Float64Array(groups * blockSize)
				let o = 0
				for (let g = 0; g < groups; g++) {
					const base = g * group + c * blockSize
					for (let i = 0; i < blockSize; i++) {
						const byte = header.bitsPerSample === 1 ? REV8[bytes[base + i]] : bytes[base + i]
						s1[o++] = stage1Ch[c].push(byte)
					}
				}
				outCh.push(stage2 ? stage2Ch[c].push(s1) : Float32Array.from(s1))
			}
		} else {
			const nFrames = bytes.length / nCh
			const s1 = Array.from({ length: nCh }, () => new Float64Array(nFrames))
			for (let f = 0, o = 0; f < nFrames; f++, o += nCh)
				for (let c = 0; c < nCh; c++) s1[c][f] = stage1Ch[c].push(bytes[o + c])
			for (let c = 0; c < nCh; c++) outCh.push(stage2 ? stage2Ch[c].push(s1[c]) : Float32Array.from(s1[c]))
		}
		return outCh
	}

	function trim(channelData) {
		if (finalEmitted >= finalLimit) return channelData.map(() => new Float32Array(0))
		const room = finalLimit - finalEmitted
		const len = channelData[0]?.length ?? 0
		if (len <= room) { finalEmitted += len; return channelData }
		finalEmitted = finalLimit
		return channelData.map((c) => c.subarray(0, room))
	}

	return {
		decode(data) {
			if (freed) throw Error('Decoder already freed')
			if (!data || !data.byteLength) return EMPTY
			let buf = data instanceof Uint8Array ? data : new Uint8Array(data)
			if (carry) { buf = catBytes(carry, buf); carry = null }
			if (!header) {
				if (buf.length < 4) { carry = buf; return EMPTY }
				const h = str4(buf, 0) === 'FRM8' ? scanDffHeader(buf) : scanDsfHeader(buf)
				if (!h) { carry = buf; return EMPTY }
				header = h
				setupFilters(h)
				buf = buf.subarray(h.dataStart)
				dataConsumed = 0
			}
			const remaining = header.dataSize - dataConsumed
			if (remaining <= 0) return EMPTY
			if (buf.length > remaining) buf = buf.subarray(0, remaining)
			const frame = header.container === 'dsf' ? header.blockSize * header.channels : header.channels
			const complete = Math.floor(buf.length / frame) * frame
			if (!complete) { carry = buf.length ? buf.slice() : null; return EMPTY }
			if (buf.length > complete) carry = buf.subarray(complete).slice()
			dataConsumed += complete
			const channelData = trim(decodeFrames(buf.subarray(0, complete)))
			return { channelData, sampleRate: ratio > 8 ? stage2.outRate : stage1.outRate }
		},
		flush() {
			if (!header || !carry || !carry.length) { carry = null; return EMPTY }
			const frame = header.container === 'dsf' ? header.blockSize * header.channels : header.channels
			const padded = new Uint8Array(Math.ceil(carry.length / frame) * frame) // zero-pad, matches the
			padded.set(carry) // DSF spec's own convention for a short final block
			carry = null
			dataConsumed += padded.length
			const channelData = trim(decodeFrames(padded))
			return { channelData, sampleRate: ratio > 8 ? stage2.outRate : stage1.outRate }
		},
		free() {
			freed = true
			header = null; carry = null; stage1 = null; stage1Ch = []; stage2 = null; stage2Ch = null
		},
	}
}

/** Decode a complete DSF or DFF buffer synchronously. */
export default function decode(src, opts) {
	const dec = decoder(opts)
	try {
		const head = dec.decode(src instanceof Uint8Array ? src : new Uint8Array(src))
		const tail = dec.flush()
		if (!head.channelData.length) return tail
		if (!tail.channelData.length) return head
		return {
			channelData: head.channelData.map((c, i) => {
				const r = new Float32Array(c.length + tail.channelData[i].length)
				r.set(c); r.set(tail.channelData[i], c.length)
				return r
			}),
			sampleRate: head.sampleRate,
		}
	} finally {
		dec.free()
	}
}
