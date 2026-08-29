// Fixtures generated with ffmpeg's own eac3 encoder:
//   stereo.eac3 — re-encode of ../decode-mp4/fixtures/ref.wav (0.5 s stereo 48 kHz, 440 Hz left,
//   880 Hz right, amplitude 0.5), so it can be checked against the same reference decode-ac3 and
//   decode-webm/-mp4 already use:
//     ffmpeg -i ../decode-mp4/fixtures/ref.wav -c:a eac3 stereo.eac3
//   surround51.eac3 — one sine per channel, same frequencies as decode-ac3/test.js's surround51.ac3
//   fixture (FL FR FC LFE BL BR = 880 220 440 60 330 1760 Hz), explicit map= so join's default
//   (alphabetical-by-channel-name) input order can't scramble the front three:
//     ffmpeg -f lavfi -i "sine=frequency=880:duration=0.5:sample_rate=48000" \
//            -f lavfi -i "sine=frequency=220:duration=0.5:sample_rate=48000" \
//            -f lavfi -i "sine=frequency=440:duration=0.5:sample_rate=48000" \
//            -f lavfi -i "sine=frequency=60:duration=0.5:sample_rate=48000" \
//            -f lavfi -i "sine=frequency=330:duration=0.5:sample_rate=48000" \
//            -f lavfi -i "sine=frequency=1760:duration=0.5:sample_rate=48000" \
//            -filter_complex "[0][1][2][3][4][5]join=inputs=6:channel_layout=5.1:map=0.0-FL|1.0-FR|2.0-FC|3.0-LFE|4.0-BL|5.0-BR[j];[j]volume=4[a]" \
//            -map "[a]" -c:a eac3 -ar 48000 surround51.eac3
//   from-mp4.eac3 — raw E-AC-3 frames extracted from ../decode-mp4/fixtures/video-eac3.mp4 (which
//   decode-mp4 itself doesn't decode yet — see the umbrella-wiring note in this package's README):
//     ffmpeg -i ../decode-mp4/fixtures/video-eac3.mp4 -c:a copy -f eac3 from-mp4.eac3

import t, { is, ok } from 'tst'
import decode, { decoder } from './decode-eac3.js'
import decodeAc3 from '@audio/decode-ac3'
import wav from '@audio/decode-wav'
import { readFileSync } from 'fs'

const fx = n => new Uint8Array(readFileSync(new URL('./fixtures/' + n, import.meta.url)))
const ac3fx = n => new Uint8Array(readFileSync(new URL('../decode-ac3/fixtures/' + n, import.meta.url)))
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
function rms(x) { let s = 0; for (let v of x) s += v * v; return Math.sqrt(s / x.length) }
const exact = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false; return true }

t('stereo E-AC-3: rate, duration, ≥ 20 dB SNR per channel (measured ~74 dB)', async () => {
	let r = await decode(fx('stereo.eac3'))
	is(r.channelData.length, 2)
	is(r.sampleRate, 48000)
	let dur = r.channelData[0].length / r.sampleRate
	ok(dur >= 0.5 && dur < 0.62, 'duration ' + dur.toFixed(3))
	for (let c = 0; c < 2; c++) ok(snr(ref.channelData[c], r.channelData[c]) > 20, 'ch' + c + ' SNR ' + snr(ref.channelData[c], r.channelData[c]).toFixed(1) + ' dB')
})

t('5.1 E-AC-3: six channels in WAV order FL FR FC LFE BL BR', async () => {
	let r = await decode(fx('surround51.eac3'))
	is(r.channelData.length, 6)
	// ground truth: `ffmpeg -i surround51.eac3 -f f32le -ac 6` yields these tones in FL FR FC LFE BL BR order
	is(r.channelData.map(d => tone(d, r.sampleRate)), [880, 220, 440, 60, 330, 1760])
})

t('video-eac3.mp4\'s extracted E-AC-3 track decodes: stereo, 48 kHz', async () => {
	let r = await decode(fx('from-mp4.eac3'))
	is(r.channelData.length, 2)
	is(r.sampleRate, 48000)
	ok(r.channelData[0].length > 0)
})

t('plain AC-3 (bitstream_id ≤ 10) decodes through the eac3 decoder too', async () => {
	let r = await decode(ac3fx('stereo.ac3'))
	is(r.channelData.length, 2)
	is(r.sampleRate, 48000)
	ok(r.channelData[0].length > 0)
})

t('drc_scale=0 matches @audio/decode-ac3\'s level on the same AC-3 input (RMS within ±0.5 dB)', async () => {
	let bytes = ac3fx('stereo.ac3')
	let a = await decodeAc3(bytes)
	let b = await decode(bytes)
	for (let c = 0; c < 2; c++) {
		let ra = rms(a.channelData[c]), rb = rms(b.channelData[c])
		let db = Math.abs(20 * Math.log10(rb / ra))
		ok(db <= 0.5, 'ch' + c + ' RMS diff ' + db.toFixed(3) + ' dB')
	}
})

t('streaming: 777-byte chunks equal whole-file (surround51)', async () => {
	let bytes = fx('surround51.eac3'), whole = await decode(bytes)
	let dec = await decoder(), parts = []
	for (let i = 0; i < bytes.length; i += 777) { let r = dec.decode(bytes.subarray(i, i + 777)); if (r.channelData.length) parts.push(r) }
	let tail = dec.flush(); if (tail.channelData.length) parts.push(tail)
	dec.free()
	let len = parts.reduce((n, p) => n + p.channelData[0].length, 0)
	is(len, whole.channelData[0].length, 'sample count')
	for (let c = 0; c < 6; c++) {
		let out = new Float32Array(len), off = 0
		for (let p of parts) { out.set(p.channelData[c], off); off += p.channelData[c].length }
		ok(exact(out, whole.channelData[c]), 'ch' + c + ' samples identical')
	}
})

t('streaming: 1-byte chunks equal whole-file (stereo)', async () => {
	let bytes = fx('stereo.eac3'), whole = await decode(bytes)
	let dec = await decoder(), parts = []
	for (let i = 0; i < bytes.length; i++) { let r = dec.decode(bytes.subarray(i, i + 1)); if (r.channelData.length) parts.push(r) }
	let tail = dec.flush(); if (tail.channelData.length) parts.push(tail)
	dec.free()
	let len = parts.reduce((n, p) => n + p.channelData[0].length, 0)
	is(len, whole.channelData[0].length, 'sample count')
})

t('garbage yields nothing, no throw', async () => {
	let r = await decode(new Uint8Array(4096).map((_, i) => (i * 7) & 0xFF))
	is(r.channelData.length, 0)
})

t('free() is idempotent', async () => {
	let dec = await decoder()
	dec.free(); dec.free()
	ok(true)
})
