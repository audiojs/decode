import t, { is, ok } from 'tst'
import decode, { decoder } from './decode-webm.js'
import wav from '@audio/decode-wav'
import { readFileSync } from 'fs'

const fx = n => new Uint8Array(readFileSync(new URL('./fixtures/' + n, import.meta.url)))
const ref = await wav(fx('ref.wav')) // 0.5 s stereo 48 kHz: 440 Hz left, 880 Hz right

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

const lossy = ['video-opus.webm', 'video-aac.mkv', 'video-mp3.mkv', 'video-vorbis.mkv', 'video-ac3.mkv', 'video-dts.mkv']
const lossless = ['video-flac.mkv', 'video-alac.mkv', 'video-pcm16.mkv', 'video-pcm16be.mkv', 'video-pcm24.mkv', 'video-f32.mkv']

for (let name of lossy) t(name + ' — audio track from video, lossy', async () => {
	let r = await decode(fx(name))
	is(r.channelData.length, 2)
	is(r.sampleRate, 48000)
	let dur = r.channelData[0].length / r.sampleRate
	ok(dur >= 0.49 && dur < 0.6, 'duration ' + dur.toFixed(3))
	for (let c = 0; c < 2; c++) ok(snr(ref.channelData[c], r.channelData[c]) > 15, 'ch' + c + ' SNR ' + snr(ref.channelData[c], r.channelData[c]).toFixed(1) + ' dB')
})

for (let name of lossless) t(name + ' — audio track from video, bit-exact', async () => {
	let r = await decode(fx(name))
	is(r.channelData.length, 2)
	is(r.sampleRate, 48000)
	is(r.channelData[0].length, ref.channelData[0].length, 'sample count')
	for (let c = 0; c < 2; c++) ok(exact(ref.channelData[c], r.channelData[c]), 'ch' + c + ' identical to reference')
})

t('unsupported codec names itself', async () => {
	let err
	try { await decode(fx('video-eac3.mkv')) } catch (e) { err = e }
	ok(err && /E-AC-3/.test(err.message), err?.message)
})

t('streaming: chunks equal whole-file (1000-byte chunks)', async () => {
	for (let name of ['video-aac.mkv', 'video-pcm16.mkv', 'video-opus.webm']) {
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

t('Opus/Vorbis stay synchronous; Matroska-only codecs resolve a Promise on the header chunk', async () => {
	let dec = await decoder()
	let r = dec.decode(fx('video-opus.webm'))
	ok(!(r instanceof Promise), 'opus sync')
	dec.free()
	dec = await decoder()
	r = dec.decode(fx('video-aac.mkv'))
	ok(r instanceof Promise, 'aac async while loading')
	await r; dec.free()
})

t('DiscardPadding trims the last block: 33600-sample source decodes to 33600 samples', async () => {
	let bytes = fx('discard-padding.webm') // @audio/encode-webm output, 0.7 s mono 440 Hz
	let r = await decode(bytes)
	is(r.channelData.length, 1)
	is(r.channelData[0].length, 33600)
	let dec = await decoder(), total = 0
	for (let i = 0; i < bytes.length; i += 700) total += (await dec.decode(bytes.subarray(i, i + 700))).channelData[0]?.length || 0
	total += (await dec.flush()).channelData[0]?.length || 0
	is(total, 33600, 'chunked')
})
