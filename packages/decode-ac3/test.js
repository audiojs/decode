import t, { is, ok } from 'tst'
import decode, { decoder } from './decode-ac3.js'
import wav from '@audio/decode-wav'
import { readFileSync } from 'fs'

const fx = n => new Uint8Array(readFileSync(new URL('./fixtures/' + n, import.meta.url)))
const ref = await wav(new Uint8Array(readFileSync(new URL('../decode-mp4/fixtures/ref.wav', import.meta.url)))) // 0.5 s stereo 48 kHz: 440 Hz left, 880 Hz right, amplitude 0.5

function snr(src, out, maxLag = 3000) {
	let best = -Infinity, n = Math.min(8000, src.length)
	for (let lag = 0; lag <= maxLag; lag++) {
		if (lag + n > out.length) break
		let e = 0, s = 0
		for (let i = 0; i < n; i++) { let d = src[i] - out[i + lag]; e += d * d; s += src[i] * src[i] }
		best = Math.max(best, 10 * Math.log10(s / e))
	}
	return best
}
// dominant tone among the 5.1 fixture's per-channel frequencies
function tone(d, sr) {
	return [60, 220, 330, 440, 880, 1760].map(f => {
		let w = 2 * Math.PI * f / sr, c = 2 * Math.cos(w), s0 = 0, s1 = 0, s2 = 0
		for (let i = 2000; i < Math.min(d.length, 22000); i++) { s0 = d[i] + c * s1 - s2; s2 = s1; s1 = s0 }
		return [f, s1 * s1 + s2 * s2 - c * s1 * s2]
	}).sort((a, b) => b[1] - a[1])[0][0]
}
const exact = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false; return true }

t('stereo AC-3: rate, duration, > 15 dB SNR per channel', async () => {
	let r = await decode(fx('stereo.ac3'))
	is(r.channelData.length, 2)
	is(r.sampleRate, 48000)
	let dur = r.channelData[0].length / r.sampleRate
	ok(dur >= 0.5 && dur < 0.62, 'duration ' + dur.toFixed(3))
	for (let c = 0; c < 2; c++) ok(snr(ref.channelData[c], r.channelData[c]) > 15, 'ch' + c + ' SNR ' + snr(ref.channelData[c], r.channelData[c]).toFixed(1) + ' dB')
})

t('5.1 AC-3: six channels in WAV order FL FR FC LFE BL BR', async () => {
	let r = await decode(fx('surround51.ac3'))
	is(r.channelData.length, 6)
	// ground truth: `ffmpeg -i surround51.ac3 -f f32le -ac 6` yields these tones in FL FR FC LFE BL BR order
	is(r.channelData.map(d => tone(d, r.sampleRate)), [880, 220, 440, 60, 330, 1760])
})

t('streaming: 777-byte chunks equal whole-file', async () => {
	let bytes = fx('stereo.ac3'), whole = await decode(bytes)
	let dec = await decoder(), parts = []
	for (let i = 0; i < bytes.length; i += 777) { let r = dec.decode(bytes.subarray(i, i + 777)); if (r.channelData.length) parts.push(r) }
	dec.free()
	let len = parts.reduce((n, p) => n + p.channelData[0].length, 0)
	is(len, whole.channelData[0].length, 'sample count')
	let out = new Float32Array(len), off = 0
	for (let p of parts) { out.set(p.channelData[1], off); off += p.channelData[1].length }
	ok(exact(out, whole.channelData[1]), 'samples identical')
})

t('garbage yields nothing, no throw', async () => {
	let r = await decode(new Uint8Array(4096).map((_, i) => (i * 7) & 0xFF))
	is(r.channelData.length, 0)
})

t('E-AC-3 is not AC-3: no frames decode', async () => {
	let r = await decode(fx('stereo.eac3')).catch(e => e)
	ok(r instanceof Error || !r.channelData.length, 'rejected or empty')
})
