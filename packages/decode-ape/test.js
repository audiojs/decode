// Fixtures generated with the Monkey's Audio SDK reference encoder (v13.26, MAC_1326_SDK.zip from
// https://monkeysaudio.com/developers.html — Monkey's Audio Source Code License; the CLI is only
// used here to produce test fixtures, nothing from the SDK is ported or shipped):
//   ffmpeg -f lavfi -i "sine=frequency=440:duration=0.5:sample_rate=44100" \
//          -f lavfi -i "sine=frequency=880:duration=0.5:sample_rate=44100" \
//          -filter_complex "[0][1]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR[j];[j]volume=0.5[a]" \
//          -map "[a]" -c:a pcm_s16le stereo16.wav        # + pcm_s24le → stereo24.wav, pcm_u8 → stereo8.wav
//   ffmpeg -f lavfi -i "sine=frequency=440:duration=0.5:sample_rate=44100" -c:a pcm_s16le mono16.wav
//   mac stereo16.wav stereo-c<N>000.ape -c<N>000              # N = 1..5 (fast/normal/high/extra high/insane)
//   mac mono16.wav mono.ape -c2000 · mac stereo24.wav stereo24.ape -c2000 · mac stereo8.wav stereo8.ape -c2000
//
// fate-*.ape are FFmpeg's own FATE test samples (rsync://samples.ffmpeg.org/fate-suite/lossless-audio/) —
// used in addition because they exercise files this SDK build (always 3.99, "new"/descriptor header)
// cannot produce: fate-luckynight-v380 / -v394b1 are real files at fileversion 3.80 and 3.94b1, the
// legacy pre-3.98 header format (parseHeader's `else` branch in decode-ape.js); fate-nolegacy-cut is
// truncated mid-frame, exercising the short-read tolerance in flush() (libavformat's own ape demuxer
// does the same: a short avio_read still gets handed to the decoder, see ape_read_packet()).
//
// Ground truth throughout: `ffmpeg -i <fixture> -f s16le/s32le/u8 -` (bit depth matching the file) —
// lossless, so every sample must match exactly, not just within a tolerance.

import t, { is, ok } from 'tst'
import decode, { decoder } from './decode-ape.js'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'

const fxUrl = n => new URL('./fixtures/' + n, import.meta.url)
const fx = n => new Uint8Array(readFileSync(fxUrl(n)))

function ffmpegPcm(name, fmt) {
	return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', fxUrl(name).pathname, '-f', fmt, '-'], { maxBuffer: 1 << 28 })
}

// Compares every sample ffmpeg produced against ours (mine may be shorter, for the truncated fixture).
function bitExact(mine, ref, ch, bits) {
	let scale = bits === 16 ? 32768 : bits === 24 ? 2147483648 : null
	let view = bits === 16 ? new Int16Array(ref.buffer, ref.byteOffset, ref.length / 2)
		: bits === 24 ? new Int32Array(ref.buffer, ref.byteOffset, ref.length / 4)
		: new Uint8Array(ref.buffer, ref.byteOffset, ref.length)
	let refN = bits === 8 ? view.length / ch : view.length / ch
	let n = Math.min(mine[0]?.length || 0, refN)
	if (!n) return false
	for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
		let want = bits === 8 ? (view[i * ch + c] - 128) / 128 : view[i * ch + c] / scale
		if (Math.abs(want - mine[c][i]) > 1e-6) return false
	}
	return true
}

for (let level of [1000, 2000, 3000, 4000, 5000]) {
	let name = 'stereo-c' + level + '.ape'
	t('stereo 16-bit, compression ' + level + ': bit-exact vs ffmpeg', async () => {
		let r = await decode(fx(name))
		is(r.channelData.length, 2)
		is(r.sampleRate, 44100)
		is(r.channelData[0].length, 22050, '0.5 s at 44.1 kHz')
		ok(bitExact(r.channelData, ffmpegPcm(name, 's16le'), 2, 16), 'bit-exact')
	})
}

t('mono 16-bit: bit-exact', async () => {
	let r = await decode(fx('mono.ape'))
	is(r.channelData.length, 1)
	ok(bitExact(r.channelData, ffmpegPcm('mono.ape', 's16le'), 1, 16), 'bit-exact')
})

t('stereo 24-bit: bit-exact', async () => {
	let r = await decode(fx('stereo24.ape'))
	is(r.channelData.length, 2)
	ok(bitExact(r.channelData, ffmpegPcm('stereo24.ape', 's32le'), 2, 24), 'bit-exact')
})

t('stereo 8-bit: bit-exact', async () => {
	let r = await decode(fx('stereo8.ape'))
	is(r.channelData.length, 2)
	ok(bitExact(r.channelData, ffmpegPcm('stereo8.ape', 'u8'), 2, 8), 'bit-exact')
})

t('FATE sample, legacy header v3.80 (pre-3.98, no descriptor block): bit-exact', async () => {
	let r = await decode(fx('fate-luckynight-v380.ape'))
	ok(r.channelData[0].length > 0, 'decoded something')
	ok(bitExact(r.channelData, ffmpegPcm('fate-luckynight-v380.ape', 's16le'), 2, 16), 'bit-exact')
})

t('FATE sample, legacy header v3.94b1: bit-exact', async () => {
	let r = await decode(fx('fate-luckynight-v394b1.ape'))
	ok(r.channelData[0].length > 0, 'decoded something')
	ok(bitExact(r.channelData, ffmpegPcm('fate-luckynight-v394b1.ape', 's16le'), 2, 16), 'bit-exact')
})

t('FATE sample truncated mid-frame: decodes the readable prefix, matches ffmpeg\'s own short read', async () => {
	let r = await decode(fx('fate-nolegacy-cut.ape'))
	ok(r.channelData[0].length > 0, 'decoded something')
	ok(bitExact(r.channelData, ffmpegPcm('fate-nolegacy-cut.ape', 's32le'), 2, 24), 'bit-exact')
})

t('streaming: arbitrary chunk sizes equal whole-file decode', async () => {
	let bytes = fx('stereo-c2000.ape'), whole = await decode(bytes)
	for (let chunkSize of [1000, 777, 1]) {
		let dec = await decoder(), parts = []
		for (let i = 0; i < bytes.length; i += chunkSize) {
			let r = dec.decode(bytes.subarray(i, i + chunkSize))
			if (r.channelData.length) parts.push(r)
		}
		let tail = dec.flush()
		if (tail.channelData.length) parts.push(tail)
		dec.free()
		let len = parts.reduce((n, p) => n + p.channelData[0].length, 0)
		is(len, whole.channelData[0].length, 'chunk ' + chunkSize + ' sample count')
		let out = new Float32Array(len), off = 0
		for (let p of parts) { out.set(p.channelData[1], off); off += p.channelData[1].length }
		let exact = true
		for (let i = 0; i < len; i++) if (Math.abs(out[i] - whole.channelData[1][i]) > 1e-6) { exact = false; break }
		ok(exact, 'chunk ' + chunkSize + ' samples identical')
	}
})

t('garbage input throws (magic mismatch)', async () => {
	let threw = false
	try { await decode(new Uint8Array(4096).map((_, i) => (i * 7) & 0xFF)) } catch { threw = true }
	ok(threw, 'threw on non-APE input')
})

t('truncated header (valid magic, stream ends before header completes) throws on flush', async () => {
	let threw = false
	try { await decode(fx('stereo-c2000.ape').slice(0, 20)) } catch { threw = true }
	ok(threw, 'threw on truncated header')
})

t('free() is idempotent', async () => {
	let dec = await decoder()
	dec.free(); dec.free()
	ok(true)
})
