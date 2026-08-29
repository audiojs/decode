/**
 * Fixtures (regenerated here if missing; needs ffmpeg 8+'s `tta` encoder/decoder):
 *   ffmpeg -i ../decode-mp4/fixtures/ref.wav -c:a tta fixtures/stereo16.tta
 *   ffmpeg -i ../decode-mp4/fixtures/ref.wav -c:a tta -sample_fmt s32 fixtures/stereo24.tta
 *   ffmpeg -i ../decode-mp4/fixtures/ref.wav -c:a tta -sample_fmt u8 fixtures/stereo8.tta
 *   ffmpeg -i ../decode-mp4/fixtures/ref.wav -ac 1 -c:a tta fixtures/mono16.tta
 *   ffmpeg -filter_complex "sine=frequency=440:duration=0.5:sample_rate=48000,volume=0.5[fl];
 *     sine=frequency=880:duration=0.5:sample_rate=48000,volume=0.5[fr];
 *     sine=frequency=330:duration=0.5:sample_rate=48000,volume=0.5[fc];
 *     sine=frequency=60:duration=0.5:sample_rate=48000,volume=0.5[lfe];
 *     sine=frequency=220:duration=0.5:sample_rate=48000,volume=0.5[bl];
 *     sine=frequency=1760:duration=0.5:sample_rate=48000,volume=0.5[br];
 *     [fl][fr][fc][lfe][bl][br]join=inputs=6:channel_layout=5.1[a]" -map "[a]" -c:a tta fixtures/surround6.tta
 *   ffmpeg -f lavfi -i "sine=frequency=440:duration=3.2:sample_rate=44100" -f lavfi -i "sine=frequency=880:duration=3.2:sample_rate=44100" \
 *     -filter_complex "[0:a][1:a]amerge=inputs=2" -c:a tta fixtures/multiframe16.tta   # 4 frames (3 full + 1 partial)
 * ref.wav: 0.5 s stereo 48 kHz s16, 440 Hz left / 880 Hz right, amplitude 0.5 (@audio/decode-mp4/fixtures/ref.wav)
 */
import t, { is, ok, throws } from 'tst'
import decode, { decoder } from './decode-tta.js'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = new URL('./fixtures/', import.meta.url)
const refWav = new URL('../decode-mp4/fixtures/ref.wav', import.meta.url).pathname

function gen(name, cmd) {
	let path = new URL(name, dir)
	if (existsSync(path)) return
	try { execSync(cmd, { stdio: 'pipe' }) } catch { /* no ffmpeg / no tta encoder — bit-exact tests below skip */ }
}
gen('stereo16.tta', `ffmpeg -y -hide_banner -loglevel error -i "${refWav}" -c:a tta "${new URL('stereo16.tta', dir).pathname}"`)
gen('stereo24.tta', `ffmpeg -y -hide_banner -loglevel error -i "${refWav}" -c:a tta -sample_fmt s32 "${new URL('stereo24.tta', dir).pathname}"`)
gen('stereo8.tta', `ffmpeg -y -hide_banner -loglevel error -i "${refWav}" -c:a tta -sample_fmt u8 "${new URL('stereo8.tta', dir).pathname}"`)
gen('mono16.tta', `ffmpeg -y -hide_banner -loglevel error -i "${refWav}" -ac 1 -c:a tta "${new URL('mono16.tta', dir).pathname}"`)
gen('surround6.tta', `ffmpeg -y -hide_banner -loglevel error -filter_complex "sine=frequency=440:duration=0.5:sample_rate=48000,volume=0.5[fl];sine=frequency=880:duration=0.5:sample_rate=48000,volume=0.5[fr];sine=frequency=330:duration=0.5:sample_rate=48000,volume=0.5[fc];sine=frequency=60:duration=0.5:sample_rate=48000,volume=0.5[lfe];sine=frequency=220:duration=0.5:sample_rate=48000,volume=0.5[bl];sine=frequency=1760:duration=0.5:sample_rate=48000,volume=0.5[br];[fl][fr][fc][lfe][bl][br]join=inputs=6:channel_layout=5.1[a]" -map "[a]" -c:a tta "${new URL('surround6.tta', dir).pathname}"`)
gen('multiframe16.tta', `ffmpeg -y -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:duration=3.2:sample_rate=44100" -f lavfi -i "sine=frequency=880:duration=3.2:sample_rate=44100" -filter_complex "[0:a][1:a]amerge=inputs=2" -c:a tta "${new URL('multiframe16.tta', dir).pathname}"`)

const fx = name => new Uint8Array(readFileSync(new URL(name, dir)))
const hasFixture = name => existsSync(new URL(name, dir))

// ffmpeg's own decode of a fixture, as raw interleaved PCM — the bit-exactness ground truth.
function ffmpegPCM(path, fmt) {
	return execSync(`ffmpeg -hide_banner -loglevel error -i "${path}" -f ${fmt} -`, { maxBuffer: 1 << 28 })
}
let hasFFmpeg = true
try { execSync('ffmpeg -version', { stdio: 'pipe' }) } catch { hasFFmpeg = false }

// raw interleaved PCM bytes -> signed integer samples (byteSize: 1=u8, 2=s16le, 3=s24le)
function parsePCM(buf, byteSize) {
	if (byteSize === 1) return Int32Array.from(buf, v => v - 128)
	if (byteSize === 2) {
		let n = buf.length / 2, out = new Int32Array(n)
		let dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
		for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true)
		return out
	}
	let n = Math.floor(buf.length / 3), out = new Int32Array(n)
	for (let i = 0; i < n; i++) {
		let v = buf[i * 3] | (buf[i * 3 + 1] << 8) | (buf[i * 3 + 2] << 16)
		if (v & 0x800000) v -= 0x1000000
		out[i] = v
	}
	return out
}
function deinterleave(flat, channels) {
	let n = Math.floor(flat.length / channels)
	return Array.from({ length: channels }, (_, c) => {
		let o = new Int32Array(n)
		for (let i = 0; i < n; i++) o[i] = flat[i * channels + c]
		return o
	})
}
// inverse of decode-tta.js's scale(): float sample -> the exact integer it was built from
function toInt(f, byteSize) {
	let neg = byteSize === 1 ? 128 : byteSize === 2 ? 32768 : 8388608
	let pos = neg - 1
	return Math.round(f < 0 ? f * neg : f * pos)
}

async function checkExact(name, fmt, byteSize) {
	if (!hasFixture(name) || !hasFFmpeg) { console.log('  » skip (no fixture/ffmpeg):', name); return }
	let path = new URL(name, dir).pathname
	let r = decode(fx(name))
	let channels = r.channelData.length
	let pcm
	try { pcm = ffmpegPCM(path, fmt) } catch { console.log('  » skip (ffmpeg decode failed):', name); return }
	let ref = deinterleave(parsePCM(pcm, byteSize), channels)
	let n = Math.min(r.channelData[0].length, ref[0].length)
	ok(n > 1000, name + ': decoded ' + n + ' samples')
	for (let c = 0; c < channels; c++) {
		let bad = 0
		for (let i = 0; i < n; i++) if (toInt(r.channelData[c][i], byteSize) !== ref[c][i]) bad++
		is(bad, 0, name + ': ch' + c + ' bit-exact vs ffmpeg (' + n + ' samples, byteSize ' + byteSize + ')')
	}
}

t('stereo 16-bit: bit-exact vs ffmpeg -f s16le', async () => checkExact('stereo16.tta', 's16le', 2))
t('stereo 24-bit: bit-exact vs ffmpeg -f s24le', async () => checkExact('stereo24.tta', 's24le', 3))
t('stereo 8-bit: bit-exact vs ffmpeg -f u8', async () => checkExact('stereo8.tta', 'u8', 1))
t('mono 16-bit: bit-exact vs ffmpeg -f s16le', async () => checkExact('mono16.tta', 's16le', 2))
t('6-channel 24-bit: bit-exact vs ffmpeg -f s24le, all 6 channels', async () => checkExact('surround6.tta', 's24le', 3))

t('stereo16: sampleRate and duration', () => {
	if (!hasFixture('stereo16.tta')) return
	let r = decode(fx('stereo16.tta'))
	is(r.sampleRate, 48000)
	let dur = r.channelData[0].length / r.sampleRate
	ok(dur > 0.49 && dur < 0.51, 'duration ' + dur.toFixed(3) + 's')
})

// ===== streaming: arbitrary chunk sizes must equal the whole-file decode =====

function chunked(bytes, size) {
	let dec = decoder(), parts = []
	for (let i = 0; i < bytes.length; i += size) {
		let r = dec.decode(bytes.subarray(i, i + size))
		if (r.channelData.length) parts.push(r)
	}
	let tail = dec.flush()
	if (tail.channelData.length) parts.push(tail)
	dec.free()
	if (!parts.length) return { channelData: [], sampleRate: 0 }
	let channels = parts[0].channelData.length
	let total = parts.reduce((s, p) => s + p.channelData[0].length, 0)
	let channelData = Array.from({ length: channels }, (_, c) => {
		let o = new Float32Array(total), off = 0
		for (let p of parts) { o.set(p.channelData[c], off); off += p.channelData[c].length }
		return o
	})
	return { channelData, sampleRate: parts[0].sampleRate }
}
function exact(a, b) {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
	return true
}

for (let size of [1000, 7]) {
	t(`streaming: ${size}-byte chunks equal whole-file decode`, () => {
		if (!hasFixture('stereo16.tta')) return
		let bytes = fx('stereo16.tta')
		let whole = decode(bytes)
		let streamed = chunked(bytes, size)
		is(streamed.channelData.length, whole.channelData.length, 'channel count')
		is(streamed.channelData[0]?.length, whole.channelData[0]?.length, 'sample count')
		for (let c = 0; c < whole.channelData.length; c++)
			ok(exact(streamed.channelData[c], whole.channelData[c]), 'ch' + c + ' samples identical')
	})
}

// ===== error handling =====

t('garbage input throws', () => {
	throws(() => decode(new Uint8Array(4096).map((_, i) => (i * 7) & 0xFF)))
})

t('too-short input throws (incomplete header, flush drops it)', () => {
	let dec = decoder()
	is(dec.decode(new Uint8Array([0x54, 0x54, 0x41, 0x31, 1, 0])).channelData.length, 0)
	is(dec.flush().channelData.length, 0)
	dec.free()
})

t('free() is idempotent and decode() throws after free', () => {
	let dec = decoder()
	dec.free()
	dec.free() // must not throw
	throws(() => dec.decode(new Uint8Array(4)))
})

// ===== CRC32 fuzzing: throw on header/seek-table corruption, skip+count on frame corruption =====

function readU16(b, o) { return b[o] | (b[o + 1] << 8) }
function readU32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 }
function layout(buf) {
	let sr = readU32(buf, 10), dataLen = readU32(buf, 14)
	let frameLen = Math.floor(sr * 256 / 245)
	let lastLen = (dataLen % frameLen) || frameLen
	let totalFrames = Math.floor(dataLen / frameLen) + (lastLen < frameLen ? 1 : 0)
	let seekEnd = 22 + totalFrames * 4 + 4
	let frameSizes = Array.from({ length: totalFrames }, (_, i) => readU32(buf, 22 + i * 4))
	return { seekEnd, totalFrames, frameSizes, frameLen, lastLen }
}

t('CRC fuzz: flipped header byte throws', () => {
	if (!hasFixture('stereo16.tta')) return
	let buf = fx('stereo16.tta').slice()
	buf[2] ^= 0xFF // inside the 18-byte header CRC's coverage
	throws(() => decode(buf))
})

t('CRC fuzz: flipped seek-table byte throws', () => {
	if (!hasFixture('stereo16.tta')) return
	let buf = fx('stereo16.tta').slice()
	buf[22] ^= 0xFF // first seek-table frame-length byte
	throws(() => decode(buf))
})

t('CRC fuzz: flipped frame byte is skipped and counted; earlier/later frames still decode identically', () => {
	if (!hasFixture('multiframe16.tta')) return
	let orig = fx('multiframe16.tta')
	let { seekEnd, totalFrames, frameSizes, frameLen } = layout(orig)
	ok(totalFrames >= 3, 'fixture has several frames: ' + totalFrames)
	let whole = decode(orig)

	let buf = orig.slice()
	let badFrame = 1 // a middle frame — full length, so the math below is exact
	let offset = seekEnd + frameSizes.slice(0, badFrame).reduce((a, b) => a + b, 0)
	buf[offset + 8] ^= 0xFF // a byte inside frame 1's payload, away from its own trailing CRC

	let dec = decoder()
	let r = dec.decode(buf)
	dec.free()
	is(dec.errors, 1, 'exactly one frame flagged')
	is(r.channelData[0].length, whole.channelData[0].length - frameLen, 'output is short by exactly one frame')

	// each channel's per-frame decode state resets every frame, so frame 0 (before the
	// corruption) and frames 2+ (after it) decode identically to the uncorrupted file —
	// only frame 1's samples are missing from the concatenated output.
	ok(exact(r.channelData[0].subarray(0, frameLen), whole.channelData[0].subarray(0, frameLen)), 'frame 0 unaffected')
	ok(exact(r.channelData[0].subarray(frameLen), whole.channelData[0].subarray(2 * frameLen)), 'frames after the corrupted one unaffected')
})

// ===== ID3v2 leading tag is skipped (synthetic — ffmpeg's own encoder never adds one) =====

t('leading ID3v2 tag is skipped before the TTA1 header', () => {
	if (!hasFixture('stereo16.tta')) return
	let tta = fx('stereo16.tta')
	let payload = 37 // arbitrary size, unrelated to the syncsafe encoding below
	let tag = new Uint8Array(10 + payload)
	tag.set([0x49, 0x44, 0x33, 4, 0, 0]) // 'ID3', v2.4.0, flags=0 (no footer)
	let sz = payload
	tag[6] = (sz >>> 21) & 0x7f; tag[7] = (sz >>> 14) & 0x7f; tag[8] = (sz >>> 7) & 0x7f; tag[9] = sz & 0x7f
	let withTag = new Uint8Array(tag.length + tta.length)
	withTag.set(tag); withTag.set(tta, tag.length)

	let plain = decode(tta)
	let tagged = decode(withTag)
	is(tagged.channelData[0]?.length, plain.channelData[0]?.length, 'sample count matches')
	ok(exact(tagged.channelData[0], plain.channelData[0]), 'samples identical to the untagged file')
})

t('leading ID3v2 tag split across chunks is still skipped', () => {
	if (!hasFixture('stereo16.tta')) return
	let tta = fx('stereo16.tta')
	let tag = new Uint8Array(10 + 5)
	tag.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5])
	let withTag = new Uint8Array(tag.length + tta.length)
	withTag.set(tag); withTag.set(tta, tag.length)
	is(chunked(withTag, 3).channelData[0]?.length, decode(tta).channelData[0]?.length)
})

// ===== speed: decode time for 60 s of stereo audio (generated to a temp file, not a fixture) =====

t('speed: decode 60s stereo', () => {
	if (!hasFFmpeg) { console.log('  » skip (no ffmpeg)'); return }
	let path = join(tmpdir(), 'audio-decode-tta-60s.tta')
	try {
		if (!existsSync(path))
			execSync(`ffmpeg -y -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:duration=60" -f lavfi -i "sine=frequency=880:duration=60" -filter_complex "[0:a][1:a]amerge=inputs=2" -c:a tta "${path}"`)
		let bytes = new Uint8Array(readFileSync(path))
		let t0 = performance.now()
		let r = decode(bytes)
		let ms = performance.now() - t0
		is(r.channelData.length, 2)
		ok(r.channelData[0].length / r.sampleRate > 59, 'decoded ~60s (' + (r.channelData[0].length / r.sampleRate).toFixed(2) + 's)')
		console.log(`  » decoded 60s stereo in ${ms.toFixed(1)}ms (${(60000 / ms).toFixed(0)}x real-time)`)
	} finally { rmSync(path, { force: true }) }
})
