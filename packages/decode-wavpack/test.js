// Fixtures generated with ffmpeg 8 (`ffmpeg -c:a wavpack`), see the ffmpeg invocation above each
// group below. hybrid.wv was made with libwavpack's own CLI (built from the lib/wavpack submodule
// via cmake, `wavpack -b3 -x ref.wav -o hybrid.wv`) since ffmpeg's native wavpack encoder has no
// hybrid/lossy mode (only lossless — `ffmpeg -h encoder=wavpack` lists no bitrate option).
// Ground truth for every lossless fixture is ffmpeg's own (independent) wavpack decoder, transcoded
// to a same-bit-depth WAV and read back with @audio/decode-wav:
//   ffmpeg -i stereo16.wv -c:a pcm_s16le stereo16.ref.wav   (and pcm_s24le / pcm_u8 / pcm_f32le)
import t, { is, ok } from 'tst'
import decode, { decoder } from './decode-wavpack.js'
import wav from '@audio/decode-wav'
import { readFileSync } from 'fs'

const fx = n => new Uint8Array(readFileSync(new URL('./fixtures/' + n, import.meta.url)))
const ref = n => wav(fx(n))

// float32 round-trip noise only — both sides compute the same v<0?v/D:v/(D-1) int→float mapping,
// one via decode-wavpack's WASM path, the other via ffmpeg's independent decoder + @audio/decode-wav.
const EPS = 2e-6
function maxDiff(a, b) {
	let n = Math.min(a.length, b.length), m = 0
	for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
	return m
}
function snr(a, b) {
	let n = Math.min(a.length, b.length), e = 0, s = 0
	for (let i = 0; i < n; i++) { let d = a[i] - b[i]; e += d * d; s += a[i] * a[i] }
	return 10 * Math.log10(s / e)
}
function tone(d, sr) {
	return [60, 220, 330, 440, 880, 1760].map(f => {
		let w = 2 * Math.PI * f / sr, c = 2 * Math.cos(w), s0 = 0, s1 = 0, s2 = 0
		for (let i = 2000; i < Math.min(d.length, 22000); i++) { s0 = d[i] + c * s1 - s2; s2 = s1; s1 = s0 }
		return [f, s1 * s1 + s2 * s2 - c * s1 * s2]
	}).sort((a, b) => b[1] - a[1])[0][0]
}

// ffmpeg -f lavfi -i "sine=440:0.5" -f lavfi -i "sine=880:0.5" -filter_complex amerge=inputs=2 -ar 48000 -c:a wavpack stereo16.wv
t('16-bit stereo lossless: bit-exact vs ffmpeg', async () => {
	let r = await decode(fx('stereo16.wv')), rr = ref('stereo16.ref.wav')
	is(r.channelData.length, 2)
	is(r.sampleRate, 48000)
	is(r.channelData[0].length, 24000, '0.5 s at 48 kHz')
	for (let c = 0; c < 2; c++) ok(maxDiff(r.channelData[c], rr.channelData[c]) < EPS, 'ch' + c)
})

// ffmpeg ... -sample_fmt s32p -bits_per_raw_sample 24 -c:a wavpack stereo24.wv
t('24-bit stereo lossless: bit-exact vs ffmpeg', async () => {
	let r = await decode(fx('stereo24.wv')), rr = ref('stereo24.ref.wav')
	is(r.channelData.length, 2)
	for (let c = 0; c < 2; c++) ok(maxDiff(r.channelData[c], rr.channelData[c]) < EPS, 'ch' + c)
})

// ffmpeg -f lavfi -i "sine=440:0.5" -sample_fmt u8p -c:a wavpack mono8.wv
t('8-bit mono lossless: bit-exact vs ffmpeg', async () => {
	let r = await decode(fx('mono8.wv')), rr = ref('mono8.ref.wav')
	is(r.channelData.length, 1)
	ok(maxDiff(r.channelData[0], rr.channelData[0]) < EPS)
})

// ffmpeg ... -sample_fmt fltp -c:a wavpack stereofloat.wv
t('float32 stereo lossless: bit-exact (raw bit reinterpretation) vs ffmpeg', async () => {
	let r = await decode(fx('stereofloat.wv')), rr = ref('stereofloat.ref.wav')
	for (let c = 0; c < 2; c++) ok(maxDiff(r.channelData[c], rr.channelData[c]) < EPS, 'ch' + c)
})

// ffmpeg -f lavfi -i "sine=880:.5" ... six sine sources merged, -channel_layout 5.1 -c:a wavpack surround51.wv
t('5.1: six channels in WAV order FL FR FC LFE BL BR, bit-exact vs ffmpeg', async () => {
	let r = await decode(fx('surround51.wv')), rr = ref('surround51.ref.wav')
	is(r.channelData.length, 6)
	is(r.channelData.map(d => tone(d, r.sampleRate)), [880, 220, 440, 60, 330, 1760])
	for (let c = 0; c < 6; c++) ok(maxDiff(r.channelData[c], rr.channelData[c]) < EPS, 'ch' + c)
})

// wavpack -b3 -x ref.wav -o hybrid.wv  (lossy hybrid, ~3 bits/sample, no .wvc correction file)
t('hybrid/lossy mode decodes, > 20 dB SNR (no .wvc correction file — not supported)', async () => {
	let r = await decode(fx('hybrid.wv')), rr = ref('hybrid.ref.wav')
	is(r.channelData.length, 2)
	for (let c = 0; c < 2; c++) ok(snr(rr.channelData[c], r.channelData[c]) > 20, 'ch' + c + ' SNR')
})

t('streaming: 1000-byte chunks equal whole-file decode', async () => {
	let bytes = fx('stereo24.wv'), whole = await decode(bytes)
	let dec = await decoder(), parts = []
	for (let i = 0; i < bytes.length; i += 1000) { let r = dec.decode(bytes.subarray(i, i + 1000)); if (r.channelData.length) parts.push(r) }
	let tail = dec.flush()
	dec.free()
	is(tail.channelData.length, 0, 'nothing left to flush — decode() already drains fully')
	let len = parts.reduce((n, p) => n + p.channelData[0].length, 0)
	is(len, whole.channelData[0].length, 'sample count')
	for (let c = 0; c < 2; c++) {
		let out = new Float32Array(len), off = 0
		for (let p of parts) { out.set(p.channelData[c], off); off += p.channelData[c].length }
		is(maxDiff(out, whole.channelData[c]), 0, 'ch' + c + ' identical to whole-file decode')
	}
})

t('streaming: ~4-byte chunks equal whole-file decode', async () => {
	let bytes = fx('stereo16.wv'), whole = await decode(bytes)
	let dec = await decoder(), parts = []
	for (let i = 0; i < bytes.length; i += 4) { let r = dec.decode(bytes.subarray(i, i + 4)); if (r.channelData.length) parts.push(r) }
	dec.free()
	let len = parts.reduce((n, p) => n + p.channelData[0].length, 0)
	is(len, whole.channelData[0].length)
	let out = new Float32Array(len), off = 0
	for (let p of parts) { out.set(p.channelData[0], off); off += p.channelData[0].length }
	is(maxDiff(out, whole.channelData[0]), 0)
})

t('garbage throws', async () => {
	let err
	try { await decode(new Uint8Array(4096).map((_, i) => (i * 7) & 0xFF)) } catch (e) { err = e }
	ok(err instanceof Error, 'rejects instead of silently returning empty/wrong data')
})

t('a real stream with trailing APEv2 tags does not throw (tag trailer is not a block)', async () => {
	let r = await decode(fx('stereo16.wv')) // ffmpeg appends an APEv2 tag after the audio blocks
	is(r.channelData.length, 2)
})

t('free() is idempotent', async () => {
	let dec = await decoder()
	dec.decode(fx('stereo16.wv'))
	dec.free()
	dec.free()
	ok(true)
})

t('decode() after free() throws', async () => {
	let dec = await decoder()
	dec.free()
	let err
	try { dec.decode(fx('stereo16.wv')) } catch (e) { err = e }
	ok(err instanceof Error)
})
