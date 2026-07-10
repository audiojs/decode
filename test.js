import decode from './audio-decode.js';
import wav from 'audio-lena/wav';
import mp3 from 'audio-lena/mp3';
import ogg from 'audio-lena/ogg';
import flac from 'audio-lena/flac';
import opus from 'audio-lena/opus';
import aiff from 'audio-lena/aiff';
import caf from 'audio-lena/caf';
import webm from 'audio-lena/webm';
import aac from 'audio-lena/aac';
import t, { is } from 'tst';
import m4a from 'audio-lena/m4a';

const isNode = typeof process !== 'undefined' && process.versions?.node
const skip = (msg) => is(true, true, 'skip: ' + msg)
async function readFile(url) {
	if (isNode) return (await import('fs')).readFileSync(url)
	let r = await fetch(url instanceof URL ? url.pathname : url)
	return new Uint8Array(await r.arrayBuffer())
}

const qoa = await readFile(new URL('./fixtures/qoa-sample.qoa', import.meta.url))
const amrNb = isNode ? await readFile(new URL('./packages/decode-amr/fixtures/test-nb.amr', import.meta.url)) : null
const wmaStereo = isNode ? await readFile(new URL('./packages/decode-wma/fixtures/stereo.wma', import.meta.url)) : null

const dur = r => r.channelData[0].length / r.sampleRate
const rms = f32 => { let s = 0; for (let i = 0; i < f32.length; i++) s += f32[i] * f32[i]; return Math.sqrt(s / f32.length) }
const near = (a, b, tol = 0.02) => Math.abs(a - b) < tol

// -- whole-file decode with content verification --

t('wav', async () => {
	let r = await decode(wav)
	is(r.channelData.length, 1)
	is(r.sampleRate, 44100)
	is(near(dur(r), 12.27), true, 'duration')
	is(near(rms(r.channelData[0]), 0.13, 0.01), true, 'rms')
})

t('mp3', async () => {
	let r = await decode(mp3)
	is(r.channelData.length, 1)
	is(r.sampleRate, 44100)
	is(near(dur(r), 12.27), true, 'duration')
	is(near(rms(r.channelData[0]), 0.13, 0.01), true, 'rms')
})

t('ogg vorbis', async () => {
	let r = await decode(ogg)
	is(r.sampleRate, 44100)
	is(near(dur(r), 12.27), true, 'duration')
	is(near(rms(r.channelData[0]), 0.13, 0.01), true, 'rms')
})

t('flac', async () => {
	let r = await decode(flac)
	is(r.sampleRate, 44100)
	is(near(dur(r), 12.27), true, 'duration')
	// flac is lossless, must match wav exactly
	is(near(rms(r.channelData[0]), 0.1298, 0.001), true, 'rms lossless')
})

t('opus', async () => {
	let r = await decode(opus)
	is(r.sampleRate, 48000)
	is(near(dur(r), 12.27), true, 'duration')
	is(near(rms(r.channelData[0]), 0.12, 0.02), true, 'rms')
})

t('m4a', async () => {
	if (!isNode) return skip('aac wasm is cjs')
	let r = await decode(m4a)
	is(r.channelData.length, 2)
	is(r.sampleRate, 44100)
	is(near(dur(r), 12.27), true, 'duration')
	is(rms(r.channelData[0]) > 0.05, true, 'has audio content')
})

t('alac (Apple Lossless) m4a', async () => {
	if (!isNode) return skip('aac wasm is cjs')
	// auto-detected as m4a, routed to the pure-JS ALAC decoder
	let mono = await readFile(new URL('./packages/decode-aac/fixtures/alac_mono.m4a', import.meta.url))
	let r = await decode(mono)
	is(r.channelData.length, 1, 'mono')
	is(r.sampleRate, 44100)
	is(r.channelData[0].length, 22050, 'sample count')
	let r24 = await decode(await readFile(new URL('./packages/decode-aac/fixtures/alac24_stereo.m4a', import.meta.url)))
	is(r24.channelData.length, 2, '24-bit stereo')
	is(r24.sampleRate, 44100)
})

t('m4a iPhone voice memo', async () => {
	if (!isNode) return skip('aac wasm is cjs')
	let hk = await readFile(new URL('./fixtures/hk.m4a', import.meta.url))
	let r = await decode(hk)
	is(r.channelData.length, 1)
	is(r.sampleRate, 48000)
	is(near(dur(r), 2.35, 0.1), true, 'duration')
	is(rms(r.channelData[0]) > 0.01, true, 'has audio content')
})

t('aiff', async () => {
	let r = await decode(aiff)
	is(r.channelData.length, 1)
	is(r.sampleRate, 44100)
	is(near(dur(r), 12.27, 0.05), true, 'duration')
	is(near(rms(r.channelData[0]), 0.13, 0.01), true, 'rms')
})

t('caf', async () => {
	let r = await decode(caf)
	is(r.channelData.length, 1)
	is(r.sampleRate, 44100)
	is(near(dur(r), 12.27), true, 'duration')
	is(near(rms(r.channelData[0]), 0.13, 0.01), true, 'rms')
})

t('webm opus', async () => {
	let r = await decode(webm)
	is(r.sampleRate, 48000)
	is(near(dur(r), 12.27), true, 'duration')
	is(near(rms(r.channelData[0]), 0.12, 0.02), true, 'rms')
})

t('qoa', async () => {
	let r = await decode(qoa)
	is(near(dur(r), 0.82, 0.05), true, 'duration')
	is(r.channelData.length >= 1, true, 'channels')
})

t('uint8array input', async () => {
	let r = await decode(new Uint8Array(wav))
	is(near(dur(r), 12.27), true)
})

t('buffer input', async () => {
	if (!isNode) return is(true, true, 'skip in browser')
	let r = await decode(Buffer.from(wav))
	is(near(dur(r), 12.27), true)
})

t('blob input', async () => {
	if (typeof Blob === 'undefined') return skip('no Blob')
	let r = await decode(new Blob([wav]))
	is(near(dur(r), 12.27), true)
})

t('response input', async () => {
	if (typeof Response === 'undefined') return skip('no Response')
	let r = await decode(new Response(wav))
	is(near(dur(r), 12.27), true)
})

// -- streaming via decoders --

t('stream mp3', async () => {
	let dec = await decode.mp3()
	let r = await dec(new Uint8Array(mp3))
	is(r.channelData.length > 0, true)
	is(r.channelData[0].length > 0, true)
	is(r.sampleRate, 44100)
	await dec()
})

t('stream wav', async () => {
	let dec = await decode.wav()
	let r = await dec(new Uint8Array(wav))
	is(r.channelData[0].length > 0, true)
	is(r.sampleRate, 44100)
})

t('stream flac', async () => {
	let dec = await decode.flac()
	let r = await dec(new Uint8Array(flac))
	is(r.channelData[0].length > 0, true)
	await dec()
})

t('stream opus', async () => {
	let dec = await decode.opus()
	let r = await dec(new Uint8Array(opus))
	is(r.channelData[0].length > 0, true)
	await dec()
})

t('stream oga', async () => {
	let dec = await decode.oga()
	let r = await dec(new Uint8Array(ogg))
	is(r.channelData[0].length > 0, true)
	await dec()
})

t('stream m4a', async () => {
	if (!isNode) return skip('aac wasm is cjs')
	let dec = await decode.m4a()
	let r = await dec(new Uint8Array(m4a))
	is(r.channelData.length > 0, true)
	is(r.channelData[0].length > 0, true)
	is(r.sampleRate, 44100)
	await dec()
})

t('stream aiff', async () => {
	let dec = await decode.aiff()
	let r = await dec(new Uint8Array(aiff))
	is(r.channelData[0].length > 0, true)
	is(r.sampleRate, 44100)
	await dec()
})

t('stream caf', async () => {
	let dec = await decode.caf()
	let r = await dec(new Uint8Array(caf))
	is(r.channelData[0].length > 0, true)
	is(r.sampleRate, 44100)
	await dec()
})

t('stream webm', async () => {
	let dec = await decode.webm()
	let r = await dec(new Uint8Array(webm))
	is(r.channelData[0].length > 0, true)
	await dec()
})

t('stream aac', async () => {
	if (!isNode) return skip('aac wasm is cjs')
	let dec = await decode.aac()
	let r = await dec(new Uint8Array(aac))
	is(r.channelData[0].length > 0, true)
	await dec()
})

t('stream amr', async () => {
	if (!isNode) return skip('amr wasm is cjs')
	let dec = await decode.amr()
	let r = await dec(new Uint8Array(amrNb))
	is(r.channelData[0].length > 0, true)
	await dec()
})

t('stream wma', async () => {
	if (!isNode) return skip('wma wasm is cjs')
	let dec = await decode.wma()
	let r = await dec(new Uint8Array(wmaStereo))
	is(r.channelData[0].length > 0, true)
	await dec()
})

// -- flush / free lifecycle --

t('double flush', async () => {
	let dec = await decode.mp3()
	await dec(new Uint8Array(mp3))
	await dec()
	let r = await dec()
	is(r.channelData.length, 0)
	is(r.sampleRate, 0)
})

t('free without flush', async () => {
	let dec = await decode.mp3()
	await dec(new Uint8Array(mp3))
	dec.free()
	let r = await dec()
	is(r.channelData.length, 0)
})

t('decode after free throws', async () => {
	let dec = await decode.mp3()
	dec.free()
	let threw = false
	try { await dec(new Uint8Array(mp3)) } catch { threw = true }
	is(threw, true)
})

t('double free is safe', async () => {
	let dec = await decode.flac()
	dec.free()
	dec.free()
})

// -- EMPTY immutability --

t('empty result is immutable', async () => {
	let dec = await decode.mp3()
	await dec()
	let r = await dec()
	let threw = false
	try { r.sampleRate = 999 } catch { threw = true }
	is(threw, true)
	try { r.channelData.push(new Float32Array(1)) } catch { threw = true }
	is(threw, true)
})

// -- input validation --

t('rejects string', async () => {
	let threw = false
	try { await decode('hello') } catch (e) { threw = e instanceof TypeError }
	is(threw, true)
})

t('rejects null', async () => {
	let threw = false
	try { await decode(null) } catch { threw = true }
	is(threw, true)
})

t('rejects number', async () => {
	let threw = false
	try { await decode(42) } catch { threw = true }
	is(threw, true)
})

t('rejects non-audio buffer', async () => {
	let threw = false
	try { await decode(new Uint8Array(100)) } catch (e) { threw = e.message.includes('Unknown audio') }
	is(threw, true)
})

// -- concurrent decoders --

t('concurrent decoding', async () => {
	let [r1, r2, r3] = await Promise.all([
		decode(mp3),
		decode(flac),
		decode(ogg),
	])
	is(near(dur(r1), 12.27), true, 'mp3 concurrent')
	is(near(dur(r2), 12.27), true, 'flac concurrent')
	is(near(dur(r3), 12.27), true, 'ogg concurrent')
})

t('concurrent stream decoders', async () => {
	let [d1, d2] = await Promise.all([decode.mp3(), decode.flac()])
	let [r1, r2] = await Promise.all([
		d1(new Uint8Array(mp3)),
		d2(new Uint8Array(flac)),
	])
	is(r1.channelData[0].length > 0, true)
	is(r2.channelData[0].length > 0, true)
	await Promise.all([d1(), d2()])
})

// -- zero-length / edge cases --

t('zero-length buffer', async () => {
	let threw = false
	try { await decode(new ArrayBuffer(0)) } catch { threw = true }
	is(threw, true)
})

t('minimal invalid buffer', async () => {
	let threw = false
	try { await decode(new Uint8Array([0])) } catch { threw = true }
	is(threw, true)
})

// -- chunked decode --

t('decode mp3', async () => {
	let chunks = [new Uint8Array(mp3)]
	async function* gen() { for (let c of chunks) yield c }
	let total = 0
	for await (let r of decode(gen(), 'mp3')) {
		is(r.sampleRate > 0, true)
		total += r.channelData[0].length
	}
	is(total > 0, true, 'decoded samples')
})

t('decode ReadableStream', async () => {
	let data = new Uint8Array(wav)
	let stream = new ReadableStream({
		start(ctrl) { ctrl.enqueue(data); ctrl.close() }
	})
	let total = 0
	for await (let r of decode(stream, 'wav')) {
		is(r.sampleRate, 44100)
		total += r.channelData[0].length
	}
	is(total > 0, true)
})

t('decode m4a', async () => {
	if (!isNode) return skip('aac wasm is cjs')
	async function* gen() { yield new Uint8Array(m4a) }
	let total = 0
	for await (let r of decode(gen(), 'm4a')) {
		is(r.sampleRate, 44100)
		total += r.channelData[0].length
	}
	is(total > 0, true)
})

t('decode m4a chunked', async () => {
	if (!isNode) return skip('aac wasm is cjs')
	// M4A needs full file (moov atom), so chunked streaming must buffer until flush
	let buf = new Uint8Array(m4a), chunkSize = 16384
	async function* gen() {
		for (let off = 0; off < buf.length; off += chunkSize)
			yield buf.subarray(off, Math.min(off + chunkSize, buf.length))
	}
	let total = 0
	for await (let r of decode(gen(), 'm4a')) {
		total += r.channelData[0].length
	}
	let ref = await decode(m4a)
	is(total, ref.channelData[0].length, 'chunked M4A matches one-shot')
})

t('decode unknown format', async () => {
	let threw = false
	try { for await (let _ of decode([], 'xyz')) {} } catch { threw = true }
	is(threw, true)
})

// -- direct format decode --

t('decode.mp3() factory', async () => {
	let dec = await decode.mp3()
	let r = await dec(new Uint8Array(mp3))
	is(r.channelData.length, 1)
	is(r.sampleRate, 44100)
	is(near(dur(r), 12.27), true, 'duration')
	await dec()
})

t('decode.mp3(source) streaming', async () => {
	let chunks = []
	async function* gen() { for (let i = 0; i < mp3.byteLength; i += 4096) yield new Uint8Array(mp3.slice(i, i + 4096)) }
	for await (let r of decode.mp3(gen())) chunks.push(r)
	is(chunks.length > 0, true, 'got chunks')
	is(chunks[0].sampleRate, 44100, 'sampleRate')
})

t('decode.aiff() factory', async () => {
	let dec = await decode.aiff()
	let r = await dec(new Uint8Array(aiff))
	is(r.channelData.length, 1)
	is(r.sampleRate, 44100)
	await dec()
})

// -- mono channel detection --

t('mono mp3 decoded as 1 channel', async () => {
	// lena mp3 is a mono source — should decode to 1 channel
	let r = await decode(mp3)
	is(r.channelData.length, 1, 'mono mp3 returns 1 channel')
})

t('stereo m4a decoded as 2 channels', async () => {
	if (!isNode) return skip('aac wasm is cjs')
	let r = await decode(m4a)
	is(r.channelData.length, 2, 'stereo m4a returns 2 channels')
})

t('dual-mono wav keeps its declared 2 channels', async () => {
	// exact containers must not collapse identical channels — dual-mono masters are
	// legitimate; the mono-upmix dedupe applies only to flagged lossy codecs (mp3 class)
	let n = 4410, mono = new Float32Array(n)
	for (let i = 0; i < n; i++) mono[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / 44100)
	// minimal PCM float32 stereo wav with identical channels
	let hdr = 44, bytes = new Uint8Array(hdr + n * 8), dv = new DataView(bytes.buffer)
	let w = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i) }
	w(0, 'RIFF'); dv.setUint32(4, 36 + n * 8, true); w(8, 'WAVEfmt ')
	dv.setUint32(16, 16, true); dv.setUint16(20, 3, true); dv.setUint16(22, 2, true)
	dv.setUint32(24, 44100, true); dv.setUint32(28, 44100 * 8, true)
	dv.setUint16(32, 8, true); dv.setUint16(34, 32, true)
	w(36, 'data'); dv.setUint32(40, n * 8, true)
	for (let i = 0; i < n; i++) { dv.setFloat32(hdr + i * 8, mono[i], true); dv.setFloat32(hdr + i * 8 + 4, mono[i], true) }
	let r = await decode(bytes)
	is(r.channelData.length, 2, 'dual-mono wav stays stereo')
	is(r.channelData[0].length, n, 'full frame count')
})

// -- decoders extensibility --

t('custom decoder registration', async () => {
	decode.test = async () => ({
		decode: async (chunk) => ({ channelData: [new Float32Array(chunk.length)], sampleRate: 8000 }),
		free() {}
	})
	let dec = await decode.test()
	let r = await dec.decode(new Uint8Array(10))
	is(r.sampleRate, 8000)
	is(r.channelData[0].length, 10)
	delete decode.test
})

// -- chunked streaming (VLC-style progressive decode) --

async function* chunked(buf, size = 4096) {
	buf = new Uint8Array(buf)
	for (let off = 0; off < buf.length; off += size)
		yield buf.subarray(off, Math.min(off + size, buf.length))
}

function streamTotal(gen, fmt) {
	return (async () => {
		let total = 0, sr = 0
		for await (let r of decode(gen, fmt)) {
			sr = r.sampleRate; total += r.channelData[0].length
		}
		return { total, sr }
	})()
}

t('chunked stream wav', async () => {
	let ref = await decode(wav)
	let { total, sr } = await streamTotal(chunked(wav, 4096), 'wav')
	is(sr, 44100)
	is(total, ref.channelData[0].length, 'samples match one-shot')
})

t('chunked stream mp3', async () => {
	let ref = await decode(mp3)
	let { total, sr } = await streamTotal(chunked(mp3, 8192), 'mp3')
	is(sr, 44100)
	is(near(total, ref.channelData[0].length, ref.channelData[0].length * 0.01), true, 'samples ~match')
})

t('chunked stream flac', async () => {
	let ref = await decode(flac)
	let { total, sr } = await streamTotal(chunked(flac, 8192), 'flac')
	is(sr, 44100)
	is(total, ref.channelData[0].length, 'lossless samples exact')
})

t('chunked stream opus', async () => {
	let ref = await decode(opus)
	let { total, sr } = await streamTotal(chunked(opus, 8192), 'opus')
	is(sr, 48000)
	is(near(total, ref.channelData[0].length, ref.channelData[0].length * 0.01), true, 'samples ~match')
})

t('chunked stream ogg vorbis', async () => {
	let ref = await decode(ogg)
	let { total, sr } = await streamTotal(chunked(ogg, 8192), 'oga')
	is(sr, 44100)
	is(near(total, ref.channelData[0].length, ref.channelData[0].length * 0.01), true, 'samples ~match')
})

t('chunked stream aiff', async () => {
	let ref = await decode(aiff)
	let { total, sr } = await streamTotal(chunked(aiff, 4096), 'aiff')
	is(sr, 44100)
	is(total, ref.channelData[0].length, 'samples match one-shot')
})

t('chunked stream caf', async () => {
	let ref = await decode(caf)
	let { total, sr } = await streamTotal(chunked(caf, 4096), 'caf')
	is(sr, 44100)
	is(total, ref.channelData[0].length, 'samples match one-shot')
})

t('chunked stream webm', async () => {
	let ref = await decode(webm)
	let { total, sr } = await streamTotal(chunked(webm, 8192), 'webm')
	is(sr, 48000)
	is(near(total, ref.channelData[0].length, ref.channelData[0].length * 0.02), true, 'samples ~match')
})

t('chunked stream m4a', async () => {
	if (!isNode) return skip('aac wasm is cjs')
	let ref = await decode(m4a)
	let { total, sr } = await streamTotal(chunked(m4a, 16384), 'm4a')
	is(sr, 44100)
	is(total, ref.channelData[0].length, 'buffered M4A matches one-shot')
})

t('chunked stream aac', async () => {
	if (!isNode) return skip('aac wasm is cjs')
	let ref = await decode(aac)
	let { total, sr } = await streamTotal(chunked(aac, 4096), 'aac')
	is(sr, ref.sampleRate)
	is(near(total, ref.channelData[0].length, ref.channelData[0].length * 0.01), true, 'ADTS samples ~match')
})

t('chunked stream amr', async () => {
	if (!isNode) return skip('amr wasm is cjs')
	let ref = await decode(amrNb)
	let { total, sr } = await streamTotal(chunked(amrNb, 1024), 'amr')
	is(sr, 8000)
	is(total, ref.channelData[0].length, 'AMR samples match one-shot')
})

t('chunked stream wma', async () => {
	if (!isNode) return skip('wma wasm is cjs')
	let ref = await decode(wmaStereo)
	let { total, sr } = await streamTotal(chunked(wmaStereo, 8192), 'wma')
	is(sr, ref.sampleRate)
	is(near(total, ref.channelData[0].length, ref.channelData[0].length * 0.02), true, 'WMA samples ~match')
})

t('chunked stream tiny chunks wav', async () => {
	// 64 bytes — smaller than WAV header, forces buffering
	let ref = await decode(wav)
	let { total } = await streamTotal(chunked(wav, 64), 'wav')
	is(total, ref.channelData[0].length, 'tiny chunks still decode all samples')
})

t('chunked stream yields multiple results', async () => {
	// verify streaming actually yields multiple chunks (not one big blob)
	let count = 0
	for await (let r of decode(chunked(wav, 4096), 'wav')) count++
	is(count > 1, true, 'multiple yields from stream')
})

// -- metadata wiring --

t('meta: oga + opus + m4a tags', async () => {
	let { oga, opus, m4a } = await import('./meta.js')
	let v = oga(await readFile(new URL('./packages/decode-vorbis/fixtures/tagged.ogg', import.meta.url)))
	is(v.meta.title, 'Lena Sine', 'oga title')
	is(v.meta.artist, 'audiojs', 'oga artist')
	is(v.sampleRate, 44100, 'oga sampleRate')
	let o = opus(await readFile(new URL('./packages/decode-opus/fixtures/tagged.opus', import.meta.url)))
	is(o.meta.album, 'Fixtures', 'opus album')
	is(o.sampleRate, 48000, 'opus sampleRate')
	let m = m4a(await readFile(new URL('./packages/decode-aac/fixtures/tagged.m4a', import.meta.url)))
	is(m.meta.title, 'Lena Sine', 'm4a title')
	is(m.meta.track, '3', 'm4a track')
	is(m.meta.pictures.length, 1, 'm4a cover art')
})
