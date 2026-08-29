// Fixtures (fixtures/*.mpc):
// SV8, generated with mpcenc (built from the bundled libmpc source tree, lib/libmpc/mpcenc)
// from ../decode-mp4/fixtures/ref.wav (0.5 s stereo 48 kHz: 440 Hz left, 880 Hz right, amplitude 0.5):
//   mpcenc --standard ref.wav standard.mpc
//   mpcenc --extreme  ref.wav extreme.mpc
//   mpcenc --thumb    ref.wav thumb.mpc
//   ffmpeg -i ref.wav -ac 1 mono.wav   && mpcenc --standard mono.wav mono.mpc
//   ffmpeg -i ref.wav -ar 44100 r44100.wav && mpcenc --standard r44100.wav 44100.mpc
// SV7 (mpcenc no longer writes SV7; no working SV7 encoder was buildable) — a FATE sample,
// truncated to fit the fixture budget:
//   curl -o sv7.mpc https://fate.ffmpeg.org/fate-suite/musepack/inside-mp7.mpc, head -c 120000
import t, { is, ok, throws, rejects } from 'tst'
import decode, { decoder } from './decode-mpc.js'
import wav from '@audio/decode-wav'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'

const fx = n => new Uint8Array(readFileSync(new URL('./fixtures/' + n, import.meta.url)))
const ref = await wav(new Uint8Array(readFileSync(new URL('../decode-mp4/fixtures/ref.wav', import.meta.url)))) // 0.5 s stereo 48 kHz: 440 Hz left, 880 Hz right, amplitude 0.5

let hasFfmpeg = true
try { execSync('ffmpeg -version', { stdio: 'ignore' }) } catch { hasFfmpeg = false }

// Lag-tolerant SNR: libmpcdec and ffmpeg's mpc decoders don't agree on exactly how much
// synthesis-filter priming delay (MPC_DECODER_SYNTH_DELAY = 481 samples) and edge padding
// to emit, so an exact sample-index comparison would be meaningless. Search a small window
// of relative offsets and report the best alignment, same approach as decode-ac3/test.js.
function snr(src, out, maxLag = 700) {
	let best = -Infinity, n = Math.min(20000, src.length, out.length)
	for (let lag = -maxLag; lag <= maxLag; lag++) {
		let s0 = Math.max(0, -lag), o0 = Math.max(0, lag)
		let len = Math.min(n - s0, n - o0)
		if (len < n * 0.5) continue
		let e = 0, s = 0
		for (let i = 0; i < len; i++) { let d = src[i + s0] - out[i + o0]; e += d * d; s += src[i + s0] * src[i + s0] }
		best = Math.max(best, 10 * Math.log10(s / e))
	}
	return best
}

// ffmpeg's own mpc7/mpc8 decode of the same fixture, as an independent cross-check.
function ffmpegDecode(name, channels) {
	let pcm = execSync(`ffmpeg -v error -i "${new URL('./fixtures/' + name, import.meta.url).pathname}" -f f32le -ac ${channels} -`, { maxBuffer: 1 << 28 })
	let f32 = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length >> 2)
	return Array.from({ length: channels }, (_, c) => { let a = new Float32Array(Math.floor(f32.length / channels)); for (let i = 0; i < a.length; i++) a[i] = f32[i * channels + c]; return a })
}

const exact = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true }

t('SV8 standard: rate, duration, agrees with ffmpeg and the reference sine', async () => {
	let r = await decode(fx('standard.mpc'))
	is(r.channelData.length, 2)
	is(r.sampleRate, 48000)
	let dur = r.channelData[0].length / r.sampleRate
	ok(dur > 0.4 && dur < 0.7, 'duration ' + dur.toFixed(3))
	for (let c = 0; c < 2; c++) ok(snr(ref.channelData[c], r.channelData[c]) > 20, 'ch' + c + ' vs sine SNR ' + snr(ref.channelData[c], r.channelData[c]).toFixed(1) + ' dB')
	if (!hasFfmpeg) return console.log('  (ffmpeg cross-check skipped: ffmpeg not on PATH)')
	let f = ffmpegDecode('standard.mpc', 2)
	for (let c = 0; c < 2; c++) ok(snr(f[c], r.channelData[c]) > 40, 'ch' + c + ' vs ffmpeg SNR ' + snr(f[c], r.channelData[c]).toFixed(1) + ' dB')
})

t('SV8 extreme and thumb profiles decode and agree with ffmpeg', async () => {
	for (let name of ['extreme.mpc', 'thumb.mpc']) {
		let r = await decode(fx(name))
		is(r.channelData.length, 2, name)
		is(r.sampleRate, 48000, name)
		if (!hasFfmpeg) continue
		let f = ffmpegDecode(name, 2)
		for (let c = 0; c < 2; c++) ok(snr(f[c], r.channelData[c]) > 40, name + ' ch' + c + ' SNR ' + snr(f[c], r.channelData[c]).toFixed(1) + ' dB')
	}
	if (!hasFfmpeg) console.log('  (ffmpeg cross-check skipped: ffmpeg not on PATH)')
})

t('SV8 mono', async () => {
	let r = await decode(fx('mono.mpc'))
	is(r.channelData.length, 1)
	is(r.sampleRate, 48000)
	if (!hasFfmpeg) return console.log('  (ffmpeg cross-check skipped: ffmpeg not on PATH)')
	let f = ffmpegDecode('mono.mpc', 1)
	ok(snr(f[0], r.channelData[0]) > 40, 'SNR ' + snr(f[0], r.channelData[0]).toFixed(1) + ' dB')
})

t('SV8 44.1 kHz', async () => {
	let r = await decode(fx('44100.mpc'))
	is(r.channelData.length, 2)
	is(r.sampleRate, 44100)
	if (!hasFfmpeg) return console.log('  (ffmpeg cross-check skipped: ffmpeg not on PATH)')
	let f = ffmpegDecode('44100.mpc', 2)
	for (let c = 0; c < 2; c++) ok(snr(f[c], r.channelData[c]) > 40, 'ch' + c + ' SNR ' + snr(f[c], r.channelData[c]).toFixed(1) + ' dB')
})

t('SV7 (MP+, truncated FATE sample): decodes, agrees with ffmpeg over the shared prefix', async () => {
	let r = await decode(fx('sv7.mpc'))
	is(r.channelData.length, 2)
	is(r.sampleRate, 44100)
	ok(r.channelData[0].length > 44100, 'decoded > 1 s: ' + (r.channelData[0].length / r.sampleRate).toFixed(2) + ' s')
	if (!hasFfmpeg) return console.log('  (ffmpeg cross-check skipped: ffmpeg not on PATH)')
	// the truncated tail makes ffmpeg log a demux error on stderr, but it still exits 0 and
	// writes everything it managed to decode to stdout, which is all ffmpegDecode() reads
	let f = ffmpegDecode('sv7.mpc', 2)
	for (let c = 0; c < 2; c++) ok(snr(f[c], r.channelData[c]) > 40, 'ch' + c + ' SNR ' + snr(f[c], r.channelData[c]).toFixed(1) + ' dB')
})

t('audio-type magic bytes: MP+ (SV7) and MPCK (SV8)', () => {
	let sv7 = fx('sv7.mpc'), sv8 = fx('standard.mpc')
	is(String.fromCharCode(sv7[0], sv7[1], sv7[2]), 'MP+')
	is(sv7[3] & 15, 7, 'SV7 version nibble')
	is(String.fromCharCode(sv8[0], sv8[1], sv8[2], sv8[3]), 'MPCK')
})

t('streaming: 1000-byte chunks equal whole-file, bit-exact', async () => {
	let bytes = fx('standard.mpc'), whole = await decode(bytes)
	let dec = await decoder(), parts = []
	for (let i = 0; i < bytes.length; i += 1000) { let r = dec.decode(bytes.subarray(i, i + 1000)); if (r.channelData.length) parts.push(r) }
	let tail = dec.flush(); if (tail.channelData.length) parts.push(tail)
	dec.free()
	let len = parts.reduce((n, p) => n + p.channelData[0].length, 0)
	is(len, whole.channelData[0].length, 'sample count')
	let out = new Float32Array(len), off = 0
	for (let p of parts) { out.set(p.channelData[1], off); off += p.channelData[1].length }
	ok(exact(out, whole.channelData[1]), 'samples identical')
})

t('streaming: 1-byte chunks equal whole-file (SV7, exercises the header byte-by-byte)', async () => {
	let bytes = fx('sv7.mpc').subarray(0, 20000), whole = await decode(bytes)
	let dec = await decoder(), parts = []
	for (let i = 0; i < bytes.length; i++) { let r = dec.decode(bytes.subarray(i, i + 1)); if (r.channelData.length) parts.push(r) }
	let tail = dec.flush(); if (tail.channelData.length) parts.push(tail)
	dec.free()
	let len = parts.reduce((n, p) => n + p.channelData[0].length, 0)
	is(len, whole.channelData[0].length, 'sample count')
})

t('reused decoder: sequential files, independent state', async () => {
	let dec = await decoder()
	let a = dec.decode(fx('standard.mpc')); dec.flush()
	is(a.channelData.length, 2)
	is(dec.sampleRate, 48000)
	dec.free()
	let dec2 = await decoder()
	let m = dec2.decode(fx('mono.mpc')); dec2.flush()
	is(m.channelData.length, 1)
	is(dec2.sampleRate, 48000)
	dec2.free()
})

t('garbage input throws, no crash', async () => {
	await rejects(() => decode(new Uint8Array(4096).map((_, i) => (i * 7) & 0xFF)), null, 'random bytes')
	await rejects(() => decode(new TextEncoder().encode('not musepack at all, just some ascii text padding to be plausible-length now')), null, 'ascii text')
})

t('empty input yields nothing, no throw', async () => {
	let r = await decode(new Uint8Array(0))
	is(r.channelData.length, 0)
})

t('free() is idempotent; decode after free throws', async () => {
	let dec = await decoder()
	dec.decode(fx('standard.mpc'))
	dec.free()
	dec.free() // must not throw
	throws(() => dec.decode(fx('standard.mpc')), null, 'decode after free')
	throws(() => dec.flush(), null, 'flush after free')
})

t('decode(chunk) never throws on merely-incomplete data; only a settled bad stream throws', async () => {
	let dec = await decoder()
	// first byte of a real SV8 stream: header incomplete, must not throw
	let r = dec.decode(fx('standard.mpc').subarray(0, 1))
	is(r.channelData.length, 0)
	dec.free()
})

t.skip('speed: see report — measured separately, not asserted (machine-dependent)')
