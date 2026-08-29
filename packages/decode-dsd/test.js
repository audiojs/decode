// Fixtures for the ffmpeg cross-check are generated in-process (not checked in as binaries) —
// see buildDsf()/writeFixture() below. To regenerate manually and inspect with ffmpeg:
//   node -e "..." > fixtures/tone.dsf   (see 'ffmpeg cross-check' test for the exact bytes)
import t, { is, ok, almost, throws } from 'tst'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import decode, { decoder } from './decode-dsd.js'
import { parseMeta } from './meta.js'

// ── byte/chunk helpers ──────────────────────────────────────────────────
function concat(...parts) {
	const len = parts.reduce((n, p) => n + p.length, 0)
	const out = new Uint8Array(len)
	let o = 0
	for (const p of parts) { out.set(p, o); o += p.length }
	return out
}
function u32le(v) { return Uint8Array.of(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF) }
function u64le(v) { const lo = v >>> 0, hi = Math.floor(v / 0x100000000) >>> 0; return concat(u32le(lo), u32le(hi)) }
function u32be(v) { return Uint8Array.of((v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF) }
function u64be(v) { const lo = v >>> 0, hi = Math.floor(v / 0x100000000) >>> 0; return concat(u32be(hi), u32be(lo)) }
function u16be(v) { return Uint8Array.of((v >>> 8) & 0xFF, v & 0xFF) }
function ascii(s) { return Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0))) }

// ── 2nd-order CIFB sigma-delta modulator (Schreier & Temes, "Understanding Delta-Sigma Data
// Converters", ch. 4: two cascaded integrators, each fed back the previous 1-bit output).
// Used only for the bulk 60 s speed-test fixture, where signal *quality* doesn't matter — just
// needs to be a valid, cheap-to-generate DSD bitstream. ──
function modulate2(dsdRate, durationSec, toneFn) {
	const n = Math.round(durationSec * dsdRate)
	const bits = new Uint8Array(n) // one byte (0/1) per DSD sample
	let x1 = 0, x2 = 0, y = -1
	for (let i = 0; i < n; i++) {
		const xin = toneFn(i / dsdRate)
		x1 += xin - y
		x2 += x1 - y
		y = x2 >= 0 ? 1 : -1
		bits[i] = y > 0 ? 1 : 0
		if (!Number.isFinite(x1) || !Number.isFinite(x2)) throw Error('modulator diverged at sample ' + i)
	}
	return bits
}

// ── 5th-order CIFB sigma-delta modulator, used for every SNR-sensitive test. ──
// A naive unity-coefficient chain of 5 integrators is unstable (verified empirically — it
// diverges within a few thousand samples for any nonzero input). A real 5th-order 1-bit modulator
// needs a properly placed NTF (zeros spread through the signal band, poles kept inside the
// H-infinity stability bound — Lee's criterion) and gain-scaled integrator coefficients (a, g, b,
// c below). These were computed with Richard Schreier's Delta-Sigma Toolbox algorithm — via its
// Python port, github.com/python-deltasigma/python-deltasigma — as:
//   ntf = synthesizeNTF(order=5, OSR=64, opt=1, H_inf=1.5)
//   a, g, b, c = realizeNTF(ntf, form='CIFB')
// CIFB state-space update (Schreier & Temes ch. 3; matches python-deltasigma's stuffABCD/CIFB):
//   v[n]  = c[N-1]*x[N-1] + b[N]*u[n]                     (quantizer input)
//   y[n]  = sign(v[n])
//   x[0]' = x[0] + b[0]*u - a[0]*y
//   x[i]' = x[i] + c[i-1]*x[i-1] + b[i]*u - a[i]*y          for i = 1..N-1
//   x[r]' -= g[j]*x[r+1]  for each resonator pair, r = (N%2) + 2*j
const CIFB5 = {
	order: 5,
	a: [0.0006604571797815388, 0.010020387441113042, 0.073723251456375, 0.3148894414295834, 0.8090083527169539],
	g: [0.0006984906006831056, 0.0019773435780344514],
	b: [0.0006604571797815388, 0.010020387441113042, 0.073723251456375, 0.3148894414295834, 0.8090083527169539, 1.0],
	c: [1.0, 1.0, 1.0, 1.0, 1.0],
}
function modulateCIFB(dsdRate, durationSec, toneFn, { order, a, g, b, c } = CIFB5) {
	const n = Math.round(durationSec * dsdRate)
	const bits = new Uint8Array(n)
	const odd = order % 2
	let x = new Float64Array(order), nx = new Float64Array(order)
	for (let i = 0; i < n; i++) {
		const u = toneFn(i / dsdRate)
		const v = c[order - 1] * x[order - 1] + b[order] * u
		const y = v >= 0 ? 1 : -1
		nx[0] = x[0] + b[0] * u - a[0] * y
		for (let k = 1; k < order; k++) nx[k] = x[k] + c[k - 1] * x[k - 1] + b[k] * u - a[k] * y
		for (let j = 0; j < g.length; j++) { const row = odd + 2 * j; nx[row] -= g[j] * x[row + 1] }
		;[x, nx] = [nx, x]
		bits[i] = y > 0 ? 1 : 0
		if (!Number.isFinite(v)) throw Error('modulator diverged at sample ' + i)
	}
	return bits
}
const sine = (amp, freq) => (t) => amp * Math.sin(2 * Math.PI * freq * t)
const twoTone = (amp, f1, f2) => (t) => amp * Math.sin(2 * Math.PI * f1 * t) + amp * Math.sin(2 * Math.PI * f2 * t)

// bit[0] is the oldest (first-in-time) sample.
function packMSB(bits) { // MSB-first: bit[0] -> bit 7 of byte 0
	const n = Math.ceil(bits.length / 8), out = new Uint8Array(n)
	for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7)
	return out
}
function packLSB(bits) { // LSB-first: bit[0] -> bit 0 of byte 0
	const n = Math.ceil(bits.length / 8), out = new Uint8Array(n)
	for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 1 << (i & 7)
	return out
}

// ── DSF container writer ────────────────────────────────────────────────
const CHANNEL_TYPE = { 1: 1, 2: 2 }
function buildDsf({ dsdRate, bitsPerSample, channelBits, id3 }) {
	const nCh = channelBits.length, blockSize = 4096
	const bytesPerCh = channelBits.map((b) => (bitsPerSample === 1 ? packLSB(b) : packMSB(b)))
	const sampleCount = channelBits[0].length
	const numBlocks = Math.ceil(bytesPerCh[0].length / blockSize)
	const padded = bytesPerCh.map((b) => { const p = new Uint8Array(numBlocks * blockSize); p.set(b); return p })
	const dataBody = new Uint8Array(numBlocks * blockSize * nCh)
	for (let g = 0; g < numBlocks; g++)
		for (let c = 0; c < nCh; c++)
			dataBody.set(padded[c].subarray(g * blockSize, (g + 1) * blockSize), (g * nCh + c) * blockSize)

	const fmtBody = concat(
		u32le(1), u32le(0), u32le(CHANNEL_TYPE[nCh]), u32le(nCh),
		u32le(dsdRate), u32le(bitsPerSample), u64le(sampleCount), u32le(blockSize), u32le(0)
	)
	const fmtChunk = concat(ascii('fmt '), u64le(12 + fmtBody.length), fmtBody)
	const dataChunk = concat(ascii('data'), u64le(12 + dataBody.length), dataBody)
	const dsdHdrSize = 28
	const metaPointer = id3 ? dsdHdrSize + fmtChunk.length + dataChunk.length : 0
	const fileSize = dsdHdrSize + fmtChunk.length + dataChunk.length + (id3 ? id3.length : 0)
	const dsdChunk = concat(ascii('DSD '), u64le(dsdHdrSize), u64le(fileSize), u64le(metaPointer))
	return concat(dsdChunk, fmtChunk, dataChunk, id3 || new Uint8Array(0))
}

// ── DFF (DSDIFF) container writer ───────────────────────────────────────
function iffChunk(id, body) { // BE 64-bit size, even-padded
	const pad = body.length & 1 ? new Uint8Array(1) : new Uint8Array(0)
	return concat(ascii(id), u64be(body.length), body, pad)
}
function buildDff({ dsdRate, channelBits, compression = 'DSD ', chanIds }) {
	const nCh = channelBits.length
	const bytesPerCh = channelBits.map(packMSB)
	const nBytes = Math.max(...bytesPerCh.map((b) => b.length))
	const dataBody = new Uint8Array(nBytes * nCh)
	for (let i = 0; i < nBytes; i++) for (let c = 0; c < nCh; c++) dataBody[i * nCh + c] = bytesPerCh[c][i] || 0

	const fver = iffChunk('FVER', u32be(0x01050000))
	const fs = iffChunk('FS  ', u32be(dsdRate))
	const ids = chanIds || (nCh === 1 ? ['SLFT'] : ['SLFT', 'SRGT'])
	const chnl = iffChunk('CHNL', concat(u16be(nCh), ...ids.map(ascii)))
	const name = compression === 'DST ' ? 'DST Encoded' : 'not compressed'
	const cmpr = iffChunk('CMPR', concat(ascii(compression), Uint8Array.of(name.length), ascii(name)))
	const propBody = concat(ascii('SND '), fs, chnl, cmpr)
	const prop = iffChunk('PROP', propBody)
	const soundChunk = compression === 'DST ' ? new Uint8Array(0) : iffChunk('DSD ', dataBody)
	const frmBody = concat(ascii('DSD '), fver, prop, soundChunk)
	return concat(ascii('FRM8'), u64be(frmBody.length), frmBody)
}

// ── minimal ID3v2.3 tag (single TIT2 frame) ─────────────────────────────
function buildId3v2(title) {
	const text = concat(Uint8Array.of(0), ascii(title)) // encoding 0 = ISO-8859-1
	const frame = concat(ascii('TIT2'), u32be(text.length), Uint8Array.of(0, 0), text)
	const size = frame.length
	const sync = Uint8Array.of((size >>> 21) & 0x7F, (size >>> 14) & 0x7F, (size >>> 7) & 0x7F, size & 0x7F)
	return concat(ascii('ID3'), Uint8Array.of(3, 0, 0), sync, frame)
}

// ── analysis: least-squares multi-tone fit (amplitude+phase-agnostic SNR) ──
// Gaussian elimination with partial pivoting, for the small (2K x 2K) normal-equations system below.
function solveLinear(M, v) {
	const n = v.length, A = M.map((row) => row.slice()), b = v.slice()
	for (let col = 0; col < n; col++) {
		let piv = col
		for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r
		;[A[col], A[piv]] = [A[piv], A[col]]; [b[col], b[piv]] = [b[piv], b[col]]
		for (let r = 0; r < n; r++) {
			if (r === col) continue
			const f = A[r][col] / A[col][col]
			for (let c = col; c < n; c++) A[r][c] -= f * A[col][c]
			b[r] -= f * b[col]
		}
	}
	return b.map((bi, i) => bi / A[i][i])
}
// Fits y ≈ Σ_k A_k cos(w_k n) + B_k sin(w_k n) by solving the FULL normal-equations system (not
// decoupled per frequency — the window is not a whole number of cycles, so the cos/sin cross
// terms don't vanish and a decoupled solve leaves a large, invisible fitting bias). Returns
// 10·log10(fitted power / residual power) — SNR against the known tone(s), any phase/delay.
function fitSNR(y, freqs, sr, skip) {
	const n = y.length - skip, K = freqs.length
	const terms = freqs.map((f) => 2 * Math.PI * f / sr)
	const M = Array.from({ length: 2 * K }, () => new Array(2 * K).fill(0))
	const rhs = new Array(2 * K).fill(0), basis = new Float64Array(2 * K)
	for (let i = 0; i < n; i++) {
		const v = y[skip + i]
		for (let k = 0; k < K; k++) { basis[2 * k] = Math.cos(terms[k] * i); basis[2 * k + 1] = Math.sin(terms[k] * i) }
		for (let p = 0; p < 2 * K; p++) { rhs[p] += v * basis[p]; for (let q = 0; q < 2 * K; q++) M[p][q] += basis[p] * basis[q] }
	}
	const coef = solveLinear(M, rhs)
	let err = 0, sig = 0
	for (let i = 0; i < n; i++) {
		let fit = 0
		for (let k = 0; k < K; k++) fit += coef[2 * k] * Math.cos(terms[k] * i) + coef[2 * k + 1] * Math.sin(terms[k] * i)
		const e = y[skip + i] - fit
		err += e * e; sig += fit * fit
	}
	return 10 * Math.log10(sig / err)
}
// "In-band" means the actual audio band, not the output's full Nyquist — a decoder targeting
// 176.4 kHz still only needs to be clean to ~20 kHz; content the modulator deliberately pushed out
// to 60-90 kHz isn't a defect. Band-limit before measuring so the SNR figure means the same thing
// at every output rate (verified: without this, in-band SNR at ratio 16 reads far lower than at
// ratio 64 for the *same* underlying signal, purely because more out-of-band shaped noise is
// still present in the wider-bandwidth output — not a real quality difference).
function audioBand(y, sr, fc = 20000) {
	const N = 255, beta = kaiserBeta(100)
	const h = designLowpass(fc, sr, N, beta)
	const out = new Float64Array(y.length - N)
	for (let k = 0; k < out.length; k++) { let s = 0; for (let n = 0; n < N; n++) s += h[n] * y[k + n]; out[k] = s }
	return out
}
function besselI0(x) { let sum = 1, term = 1, k = 1; const y = (x * x) / 4; while (k < 64 && term > sum * 1e-16) { term *= y / (k * k); sum += term; k++ }; return sum }
function kaiserBeta(A) { if (A > 50) return 0.1102 * (A - 8.71); if (A >= 21) return 0.5842 * Math.pow(A - 21, 0.4) + 0.07886 * (A - 21); return 0 }
function designLowpass(fc, fs, N, beta) {
	const h = new Float64Array(N), M = (N - 1) / 2, wc = (2 * Math.PI * fc) / fs, i0b = besselI0(beta)
	let sum = 0
	for (let n = 0; n < N; n++) {
		const m = n - M
		const sinc = m === 0 ? wc / Math.PI : Math.sin(wc * m) / (Math.PI * m)
		const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - (m / M) ** 2))) / i0b
		h[n] = sinc * w; sum += h[n]
	}
	for (let n = 0; n < N; n++) h[n] /= sum
	return h
}

// Goertzel: magnitude (peak amplitude, assuming a real sinusoid) and phase (radians) at freq f.
function goertzel(y, freq, sr) {
	const n = y.length, w = 2 * Math.PI * freq / sr, cr = Math.cos(w), coeff = 2 * cr
	let s1 = 0, s2 = 0
	for (let i = 0; i < n; i++) { const s0 = y[i] + coeff * s1 - s2; s2 = s1; s1 = s0 }
	const real = s1 - s2 * cr, imag = s2 * Math.sin(w)
	return { mag: (2 / n) * Math.hypot(real, imag), phase: Math.atan2(imag, real) }
}

const DSD64 = 2822400

// ── tests ────────────────────────────────────────────────────────────────

t('DSF stereo, LSB-first (bitsPerSample=1): 1 kHz tone decodes at 88.2k/44.1k/176.4k with SNR >= 80 dB', () => {
	const dur = 0.3
	const bitsL = modulateCIFB(DSD64, dur, sine(0.5, 1000))
	const bitsR = modulateCIFB(DSD64, dur, sine(0.5, 1000))
	const dsf = buildDsf({ dsdRate: DSD64, bitsPerSample: 1, channelBits: [bitsL, bitsR] })
	for (const sampleRate of [88200, 44100, 176400]) {
		const r = decode(dsf, { sampleRate })
		is(r.channelData.length, 2)
		is(r.sampleRate, sampleRate)
		const skip = Math.round(sampleRate * 0.02) // settle past the zero-history startup transient
		const band = audioBand(r.channelData[0].subarray(skip), sampleRate)
		const snr = fitSNR(band, [1000], sampleRate, 0)
		// 5th-order NTF (H_inf=1.5, OSR=64) theoretical in-band limit is well over 100 dB (Schreier
		// & Temes ch. 4); 80 dB is a conservative floor under our filter's own 100 dB stopband
		// target and real (non-idealized) 1-bit quantizer behavior.
		ok(snr >= 80, `${sampleRate}Hz SNR ${snr.toFixed(1)} dB`)
	}
})

t('DSF mono, MSB-first (bitsPerSample=8): decodes with SNR >= 80 dB at 88.2k', () => {
	const dur = 0.3
	const bits = modulateCIFB(DSD64, dur, sine(0.5, 1000))
	const dsf = buildDsf({ dsdRate: DSD64, bitsPerSample: 8, channelBits: [bits] })
	const r = decode(dsf, { sampleRate: 88200 })
	is(r.channelData.length, 1)
	const band = audioBand(r.channelData[0].subarray(1800), 88200)
	const snr = fitSNR(band, [1000], 88200, 0)
	ok(snr >= 80, `mono MSB-first SNR ${snr.toFixed(1)} dB`)
})

t('DSF two-tone signal decodes with SNR >= 80 dB', () => {
	const dur = 0.3
	const bits = modulateCIFB(DSD64, dur, twoTone(0.25, 1000, 3000))
	const dsf = buildDsf({ dsdRate: DSD64, bitsPerSample: 1, channelBits: [bits] })
	const r = decode(dsf, { sampleRate: 88200 })
	const band = audioBand(r.channelData[0].subarray(1800), 88200)
	const snr = fitSNR(band, [1000, 3000], 88200, 0)
	ok(snr >= 80, `two-tone SNR ${snr.toFixed(1)} dB`)
})

t('DFF stereo: 1 kHz tone decodes with SNR >= 80 dB at 88.2k/44.1k', () => {
	const dur = 0.3
	const bitsL = modulateCIFB(DSD64, dur, sine(0.5, 1000))
	const bitsR = modulateCIFB(DSD64, dur, sine(0.5, 1000))
	const dff = buildDff({ dsdRate: DSD64, channelBits: [bitsL, bitsR] })
	for (const sampleRate of [88200, 44100]) {
		const r = decode(dff, { sampleRate })
		is(r.channelData.length, 2)
		is(r.sampleRate, sampleRate)
		const skip = Math.round(sampleRate * 0.02)
		const band = audioBand(r.channelData[0].subarray(skip), sampleRate)
		const snr = fitSNR(band, [1000], sampleRate, 0)
		ok(snr >= 80, `dff ${sampleRate}Hz SNR ${snr.toFixed(1)} dB`)
	}
})

t('DFF with DST compression throws Unsupported: DST', () => {
	const bits = modulate2(DSD64, 0.01, sine(0.5, 1000))
	const dff = buildDff({ dsdRate: DSD64, channelBits: [bits], compression: 'DST ' })
	throws(() => decode(dff), /Unsupported: DST/)
	const dec = decoder()
	throws(() => dec.decode(dff), /Unsupported: DST/)
})

t('garbage input throws', () => {
	const junk = new Uint8Array(4096).map((_, i) => (i * 31 + 7) & 0xFF)
	throws(() => decode(junk))
})

t('free() is idempotent', () => {
	const dec = decoder()
	dec.free()
	dec.free()
	ok(true, 'no throw')
})

t('ID3v2 metadata parses from a DSF trailing tag', () => {
	const bits = modulate2(DSD64, 0.02, sine(0.5, 1000))
	const id3 = buildId3v2('Test Title')
	const dsf = buildDsf({ dsdRate: DSD64, bitsPerSample: 1, channelBits: [bits], id3 })
	const meta = parseMeta(dsf)
	ok(meta, 'metadata found')
	is(meta.meta.title, 'Test Title')
})

t('chunked decode (1000-byte and 4096-byte-misaligned chunks) equals whole-file decode', () => {
	const dur = 0.2
	const bitsL = modulateCIFB(DSD64, dur, sine(0.5, 1000))
	const bitsR = modulateCIFB(DSD64, dur, sine(0.5, 1000))
	const dsf = buildDsf({ dsdRate: DSD64, bitsPerSample: 1, channelBits: [bitsL, bitsR] })
	const whole = decode(dsf, { sampleRate: 88200 })

	for (const chunkSize of [1000, 4097]) {
		const dec = decoder({ sampleRate: 88200 })
		const parts = []
		for (let i = 0; i < dsf.length; i += chunkSize) {
			const r = dec.decode(dsf.subarray(i, i + chunkSize))
			if (r.channelData.length) parts.push(r)
		}
		const tail = dec.flush()
		if (tail.channelData.length) parts.push(tail)
		dec.free()
		const total = parts.reduce((n, p) => n + p.channelData[0].length, 0)
		is(total, whole.channelData[0].length, `chunk=${chunkSize} sample count`)
		const out0 = new Float32Array(total), out1 = new Float32Array(total)
		let o = 0
		for (const p of parts) { out0.set(p.channelData[0], o); out1.set(p.channelData[1], o); o += p.channelData[0].length }
		let maxDiff = 0
		for (let i = 0; i < total; i++) maxDiff = Math.max(maxDiff, Math.abs(out0[i] - whole.channelData[0][i]), Math.abs(out1[i] - whole.channelData[1][i]))
		is(maxDiff, 0, `chunk=${chunkSize} bit-exact vs whole-file`)
	}
})

let hasFFmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFFmpeg = false }

// Best integer-sample lag aligning a to b: a[i+lag] ~ b[i]. The two decoders' overall group delay
// differs (different filter lengths/cutoffs at each stage), so a fair phase comparison needs
// delay removed first — same principle as test 1's "aligning for filter delay", applied across
// decoders instead of against an analytic reference. A pure 1 kHz tone repeats every ~88.2
// samples at 88.2 kHz, so a correlation search has a near-tied local maximum every period —
// confirmed empirically: searching out to +-300 samples lands on lags 88.2 samples apart with
// scores within 0.1% of each other, aliased copies of the one true (smallest) delay. The true
// group delay of a well-behaved decimator is well under one tone period here, so restricting the
// search to less than that period (+-80) reliably finds the single, unambiguous, smoothly-peaked
// maximum instead.
function bestLag(a, b, maxLag) {
	const n = Math.min(4000, a.length, b.length)
	let bestLag = 0, bestScore = -Infinity
	for (let lag = -maxLag; lag <= maxLag; lag++) {
		let s = 0
		for (let i = 0; i < n; i++) {
			const ai = i + lag
			if (ai < 0 || ai >= a.length) continue
			s += a[ai] * b[i]
		}
		if (s > bestScore) { bestScore = s; bestLag = lag }
	}
	return bestLag
}

const ffmpegTest = hasFFmpeg ? t : t.skip
ffmpegTest('ffmpeg cross-check: 1 kHz tone amplitude/phase within 0.1 dB / 2 deg, duration within 1 ms', () => {
	const dur = 0.3, sr = 88200
	const bitsL = modulateCIFB(DSD64, dur, sine(0.5, 1000))
	const bitsR = modulateCIFB(DSD64, dur, sine(0.5, 1000))
	const dsf = buildDsf({ dsdRate: DSD64, bitsPerSample: 1, channelBits: [bitsL, bitsR] })

	const dir = new URL('./fixtures/', import.meta.url)
	mkdirSync(dir, { recursive: true })
	const path = new URL('tone.dsf', dir)
	writeFileSync(path, dsf)
	try {
		// ffmpeg's dsd_lsbf_planar decodes natively to dsdRate/8 (352.8 kHz), then its resampler
		// brings it to 88.2 kHz — same two-stage shape as this decoder, different filters.
		const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path.pathname, '-f', 'f32le', '-ar', String(sr), '-ac', '2', '-'], { maxBuffer: 1 << 28 })
		const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.length >> 2)
		const ffL = new Float32Array(pcm.length / 2)
		for (let i = 0; i < ffL.length; i++) ffL[i] = pcm[i * 2]

		const mine = decode(dsf, { sampleRate: sr })
		const myL = mine.channelData[0]

		const skip = 1800
		const lag = bestLag(myL, ffL, 80)
		// Window must fit inside both arrays without clipping — Goertzel's phase is referenced to
		// the window's own end, so two differently-clipped windows silently reintroduce the very
		// delay this is supposed to remove (confirmed empirically: a window long enough to clip
		// made the lag correction a no-op, reproducing the raw lag=0 phase error regardless of lag).
		const win = 16384
		const mineTone = goertzel(myL.subarray(skip + lag, skip + lag + win), 1000, sr)
		const ffTone = goertzel(ffL.subarray(skip, skip + win), 1000, sr)
		const dbDiff = 20 * Math.log10(mineTone.mag / ffTone.mag)
		let degDiff = (mineTone.phase - ffTone.phase) * 180 / Math.PI
		degDiff = ((degDiff + 180) % 360 + 360) % 360 - 180
		ok(Math.abs(dbDiff) < 0.1, `amplitude diff ${dbDiff.toFixed(3)} dB`)
		ok(Math.abs(degDiff) < 2, `phase diff ${degDiff.toFixed(2)} deg (lag ${lag} samples)`)

		const myDur = myL.length / sr, ffDur = ffL.length / sr
		ok(Math.abs(myDur - ffDur) < 0.001, `duration diff ${(Math.abs(myDur - ffDur) * 1000).toFixed(2)} ms`)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

t('speed: 60 s stereo DSD64 -> 88.2k decodes in under 3 s', () => {
	const dur = 60
	const bitsL = modulate2(DSD64, dur, sine(0.5, 1000))
	const bitsR = modulate2(DSD64, dur, sine(0.5, 1000))
	const dsf = buildDsf({ dsdRate: DSD64, bitsPerSample: 1, channelBits: [bitsL, bitsR] })
	const t0 = performance.now()
	const r = decode(dsf, { sampleRate: 88200 })
	const ms = performance.now() - t0
	is(r.channelData.length, 2)
	almost(r.channelData[0].length / 88200, 60, 0.01)
	ok(ms < 3000, `decoded 60s stereo DSD64 -> 88.2k in ${ms.toFixed(0)} ms`)
})
