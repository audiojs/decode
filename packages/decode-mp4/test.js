import t, { is, ok } from 'tst'
import decode, { decoder } from './decode-mp4.js'
import wav from '@audio/decode-wav'
import { readFileSync } from 'fs'

const fx = n => new Uint8Array(readFileSync(new URL('./fixtures/' + n, import.meta.url)))
const ref = await wav(fx('ref.wav')) // 0.5 s stereo 48 kHz: 440 Hz left, 880 Hz right

const rms = d => { let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return Math.sqrt(s / d.length) }
// best SNR (dB) of `out` against `src` over codec-delay lags — out may lead by priming samples
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
const exact = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-4) return false; return true }

const lossy = ['video-aac.mp4', 'video-aac.mov', 'video-aac.3gp', 'video-mp3.mp4', 'video-opus.mp4', 'video-ac3.mp4', 'video-dts.mp4']
const lossless = ['video-flac.mp4', 'video-alac.mov', 'video-pcm16.mov', 'video-pcm16be.mov', 'video-pcm24.mov', 'video-f32.mov', 'video-pcm16.mp4']

for (let name of lossy) t(name + ' — audio track from video, lossy', async () => {
	let r = await decode(fx(name))
	is(r.channelData.length, 2)
	is(r.sampleRate, 48000)
	let dur = r.channelData[0].length / r.sampleRate
	ok(dur >= 0.5 && dur < 0.6, 'duration ' + dur.toFixed(3))
	for (let c = 0; c < 2; c++) ok(snr(ref.channelData[c], r.channelData[c]) > 15, 'ch' + c + ' SNR ' + snr(ref.channelData[c], r.channelData[c]).toFixed(1) + ' dB')
})

for (let name of lossless) t(name + ' — audio track from video, bit-exact', async () => {
	let r = await decode(fx(name))
	is(r.channelData.length, 2)
	is(r.sampleRate, 48000)
	is(r.channelData[0].length, ref.channelData[0].length, 'sample count')
	for (let c = 0; c < 2; c++) ok(exact(ref.channelData[c], r.channelData[c]), 'ch' + c + ' identical to reference')
})

t('video-eac3.mp4 — E-AC-3 track routes to @audio/decode-eac3', async () => {
	let r = await decode(fx('video-eac3.mp4'))
	is(r.sampleRate, 48000, 'E-AC-3 is always 48 kHz')
	is(r.channelData.length, 2, 'stereo')
	// tones as in the other video fixtures: 440 Hz left, 880 Hz right (Goertzel pick among candidates)
	let tone = d => [220, 440, 880, 1760].map(f => {
		let w = 2 * Math.PI * f / r.sampleRate, c = 2 * Math.cos(w), s0 = 0, s1 = 0, s2 = 0
		for (let i = 2000; i < Math.min(d.length, 22000); i++) { s0 = d[i] + c * s1 - s2; s2 = s1; s1 = s0 }
		return [f, s1 * s1 + s2 * s2 - c * s1 * s2]
	}).sort((a, b) => b[1] - a[1])[0][0]
	is(tone(r.channelData[0]), 440, 'left tone')
	is(tone(r.channelData[1]), 880, 'right tone')
})

t('streaming: chunks equal whole-file (moov after mdat, 1000-byte chunks)', async () => {
	for (let name of ['video-aac.mov', 'video-pcm16.mov', 'video-pcm16.mp4']) {
		let bytes = fx(name), whole = await decode(bytes)
		let dec = await decoder(), parts = []
		for (let i = 0; i < bytes.length; i += 1000) {
			let r = await dec.decode(bytes.subarray(i, i + 1000))
			if (r.channelData.length) parts.push(r)
		}
		let tail = await dec.flush()
		if (tail.channelData.length) parts.push(tail)
		let len = parts.reduce((n, p) => n + p.channelData[0].length, 0)
		is(len, whole.channelData[0].length, name + ' sample count')
		let out = new Float32Array(len), off = 0
		for (let p of parts) { out.set(p.channelData[1], off); off += p.channelData[1].length }
		ok(exact(out, whole.channelData[1]), name + ' samples identical')
	}
})

t('rejects non-MP4 and empty input', async () => {
	let err
	try { await decode(new Uint8Array(100)) } catch (e) { err = e }
	ok(err, 'garbage throws: ' + err?.message)
	err = null
	try { await decode('nope') } catch (e) { err = e }
	ok(err instanceof TypeError)
})
