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
import { decoder as vorbisDecoder } from '@audio/decode-vorbis';
import { decoder as flacDecoder } from '@audio/decode-flac';

const isNode = typeof process !== 'undefined' && process.versions?.node
const skip = (msg) => is(true, true, 'skip: ' + msg)
async function readFile(url) {
	if (isNode) return (await import('fs')).readFileSync(url)
	let r = await fetch(url instanceof URL ? url.pathname : url)
	return new Uint8Array(await r.arrayBuffer())
}

const qoa = await readFile(new URL('./fixtures/qoa-sample.qoa', import.meta.url))
const shortOgg = await readFile(new URL('./packages/decode-vorbis/fixtures/short.ogg', import.meta.url))
const shortOggFlac = await readFile(new URL('./packages/decode-flac/fixtures/mono.oga', import.meta.url))
const amrNb = await readFile(new URL('./packages/decode-amr/fixtures/test-nb.amr', import.meta.url))
const amrWb = await readFile(new URL('./packages/decode-amr/fixtures/test-wb.amr', import.meta.url))
const webmVorbis = await readFile(new URL('./node_modules/audio-lena/lena-vorbis.webm', import.meta.url))
const alacMono = await readFile(new URL('./packages/decode-aac/fixtures/alac_mono.m4a', import.meta.url))
const wmaMono = await readFile(new URL('./packages/decode-wma/fixtures/mono.wma', import.meta.url))
const wmaStereo = await readFile(new URL('./packages/decode-wma/fixtures/stereo.wma', import.meta.url))
const videoMp4 = await readFile(new URL('./packages/decode-mp4/fixtures/video-aac.mp4', import.meta.url))
const videoMov = await readFile(new URL('./packages/decode-mp4/fixtures/video-pcm16.mov', import.meta.url))
const videoMkv = await readFile(new URL('./packages/decode-webm/fixtures/video-aac.mkv', import.meta.url))
const videoWebm = await readFile(new URL('./packages/decode-webm/fixtures/video-opus.webm', import.meta.url))
const videoAvi = await readFile(new URL('./packages/decode-avi/fixtures/video-mp3.avi', import.meta.url))
const rawAc3 = await readFile(new URL('./packages/decode-ac3/fixtures/stereo.ac3', import.meta.url))
const rawDts = await readFile(new URL('./packages/decode-dts/fixtures/stereo.dts', import.meta.url))
const videoAc3 = await readFile(new URL('./packages/decode-webm/fixtures/video-ac3.mkv', import.meta.url))

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

t('reusable compact ogg vorbis', async () => {
	let dec = await vorbisDecoder()
	for (let i = 0; i < 3; i++) {
		let input = i ? shortOgg : shortOgg.buffer.slice(shortOgg.byteOffset, shortOgg.byteOffset + shortOgg.byteLength)
		let r = dec.decode(input)
		is(r instanceof Promise, false, 'synchronous result')
		is(r.channelData.length, 2)
		is(r.channelData[0].length, 13248)
		is(r.sampleRate, 44100)
	}
	dec.free()
})

t('flac', async () => {
	let r = await decode(flac)
	is(r.sampleRate, 44100)
	is(near(dur(r), 12.27), true, 'duration')
	// flac is lossless, must match wav exactly
	is(near(rms(r.channelData[0]), 0.1298, 0.001), true, 'rms lossless')
})

t('reusable complete ogg flac', async () => {
	let dec = await flacDecoder()
	for (let i = 0; i < 2; i++) {
		let r = dec.decode(shortOggFlac)
		is(r instanceof Promise, false, 'synchronous result')
		is(r.channelData.length, 1)
		is(r.channelData[0].length, 12000)
		is(r.sampleRate, 48000)
	}
	dec.free()
})

t('reusable zero-total raw flac', async () => {
	let input = new Uint8Array(flac).slice()
	input[21] &= 0xf0
	input.fill(0, 22, 42)
	let reference = await decode(flac)
	let dec = await flacDecoder()
	for (let i = 0; i < 3; i++) {
		let r = dec.decode(input)
		is(r instanceof Promise, false, 'synchronous result')
		is(r.channelData.length, 1)
		is(r.channelData[0].length, reference.channelData[0].length)
		is(r.sampleRate, 44100)
	}
	dec.free()
})

t('opus', async () => {
	let r = await decode(opus)
	is(r.sampleRate, 48000)
	is(near(dur(r), 12.27), true, 'duration')
	is(near(rms(r.channelData[0]), 0.12, 0.02), true, 'rms')
})

t('m4a', async () => {
	let r = await decode(m4a)
	is(r.channelData.length, 2)
	is(r.sampleRate, 44100)
	is(near(dur(r), 12.27), true, 'duration')
	is(rms(r.channelData[0]) > 0.05, true, 'has audio content')
})

t('alac (Apple Lossless) m4a', async () => {
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

const workletAudio = (channels, samples, sampleRate, active = true) =>
	({ sync: true, channels, samples, sampleRate, finite: true, active })
const workletPCM = {
	flacA: workletAudio(1, 12000, 48000),
	flacB: workletAudio(1, 541184, 44100),
	vorbisA: workletAudio(2, 13248, 44100),
	vorbisB: workletAudio(1, 541184, 44100),
	mp3: workletAudio(2, 541184, 44100),
	opusBody: workletAudio(1, 575688, 48000),
	opusTail: workletAudio(1, 13356, 48000),
	webmOpus: workletAudio(1, 589044, 48000), // 589128 encoded minus the 84-sample DiscardPadding on the last block
	webmVorbisBody: workletAudio(1, 432064, 44100),
	webmVorbisTail: workletAudio(1, 110080, 44100),
	aac: workletAudio(1, 542720, 44100),
	m4a: workletAudio(2, 541696, 44100),
	alac: workletAudio(1, 22050, 44100),
	amrNb: workletAudio(1, 8000, 8000, false),
	amrWb: workletAudio(1, 16000, 16000),
	wmaMono: workletAudio(1, 45056, 44100),
	wmaStereo: workletAudio(2, 45056, 44100),
	wav: workletAudio(1, 541184, 44100),
	aiff: workletAudio(1, 542144, 44100),
	caf: workletAudio(1, 541184, 44100),
	qoa: workletAudio(1, 39431, 48000),
}
const workletEmpty = workletAudio(0, 0, 0, false)

// Chromium and Firefox AudioWorkletGlobalScope omit these browser globals.
t('worklet-like scope', async () => {
	if (!isNode) return skip('real worklet test covers browser')
	let { execFileSync } = await import('node:child_process')
	let script = `
		const mp3 = (await import('audio-lena/mp3')).default
		const fs = await import('node:fs')
		const sample = 'aΩλ中\u{1D11E}'
		const bytes = [...new TextEncoder().encode(sample)]
		for (const g of ['TextDecoder', 'TextEncoder', 'Blob', 'Worker', 'atob', 'btoa', 'fetch', 'performance', 'setTimeout', 'URL']) delete globalThis[g]
		const { TextDecoder } = await import('./packages/_build/text-decoder.js')
		if (new TextDecoder().decode(new Uint8Array(bytes)) !== sample) throw Error('utf8 fallback mismatch')
		const out = {}
		for (const [name, path, fixture] of [
			['flacA', './packages/decode-flac/decode-flac.js', './packages/decode-flac/fixtures/mono.oga'],
			['vorbisA', './packages/decode-vorbis/decode-vorbis.js', './packages/decode-vorbis/fixtures/short.ogg'],
			['mp3', './packages/decode-mp3/decode-mp3.js', null],
		]) {
			const decode = (await import(path)).default
			const { channelData, sampleRate } = await decode(fixture ? new Uint8Array(fs.readFileSync(fixture)) : mp3)
			out[name] = {
				channels: channelData.length,
				samples: channelData[0]?.length || 0,
				sampleRate,
				finite: channelData.every(ch => ch.every(Number.isFinite)),
				active: channelData.some(ch => ch.some(sample => sample !== 0)),
			}
		}
		console.log(JSON.stringify(out))
	`
	let report = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' }))
	for (let name of ['flacA', 'vorbisA', 'mp3']) {
		let { sync, ...expected } = workletPCM[name]
		is(report[name], expected, name)
	}
})

t('worklet bundles omit worker runtime', async () => {
	if (!isNode) return skip('generated bundle check runs in Node')
	let workerRuntime = /WASMAudioDecoderWorker|DecoderWebWorker|new Blob|Buffer\.from|globalThis\.Worker|process\.versions/
	for (let name of ['flac', 'vorbis', 'mp3', 'webm']) {
		let source = String(await readFile(new URL(`./packages/decode-${name}/decode-${name}.js`, import.meta.url)))
		is(workerRuntime.test(source), false, name)
	}
})

t('worklet WASM loaders are static ES modules', async () => {
	if (!isNode) return skip('generated loader check runs in Node')
	// codec packages may import sibling @audio/decode-* packages on demand; WASM itself must load statically
	let dynamicLoader = /\bimport\s*\(\s*(?!['"]@audio\/decode-)|node:module|\.wasm\.cjs/
	let paths = [
		'decode-opus/core.js', 'decode-opus/src/opus.wasm.js',
		'decode-webm/decode-webm.js', 'decode-webm/src/opus.wasm.js',
		'decode-aac/decode-aac.js', 'decode-aac/src/aac.wasm.js',
		'decode-amr/decode-amr.js', 'decode-amr/src/amr.wasm.js',
		'decode-wma/decode-wma.js', 'decode-wma/src/wma.wasm.js',
	]
	for (let path of paths) {
		let source = String(await readFile(new URL('./packages/' + path, import.meta.url)))
		is(dynamicLoader.test(source), false, path)
	}
	for (let name of ['opus', 'aac', 'amr', 'wma']) {
		let source = String(await readFile(new URL(`./packages/decode-${name}/src/${name}.wasm.js`, import.meta.url)))
		is(source.includes('ENVIRONMENT_IS_AUDIO_WORKLET'), true, name + ' worklet target')
	}
	for (let path of ['decode-opus/build.sh', 'decode-aac/build.sh', 'decode-amr/build.sh', 'decode-wma/build.sh', 'decode-wma/build-ffmpeg.sh']) {
		let source = String(await readFile(new URL('./packages/' + path, import.meta.url)))
		let staticWorklet = !source.includes('.cjs') && source.includes('-s EXPORT_ES6=1') &&
			source.includes("-s ENVIRONMENT='web,worklet,shell'") && source.includes('-s SINGLE_FILE=1')
		is(staticWorklet, true, path)
	}
})

t('umbrella browser bundle', async () => {
	if (!isNode) return skip('esbuild runs in Node')
	let { build } = await import('esbuild')
	let result = await build({
		entryPoints: [new URL('./audio-decode.js', import.meta.url).pathname],
		bundle: true,
		splitting: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		outdir: 'out',
		write: false,
		logLevel: 'silent',
	})
	is(result.outputFiles.length > 1, true, 'entry and lazy codec chunks')
})

t('audio worklet scope', async () => {
	if (isNode || typeof OfflineAudioContext === 'undefined') return skip('browser only')
	let fixtures = {
		flacA: shortOggFlac, flacB: flac, vorbisA: shortOgg, vorbisB: ogg,
		mp3, opus, webmOpus: webm, webmVorbis, aac, m4a, alac: alacMono, amrNb, amrWb,
		wmaMono, wmaStereo, wav, aiff, caf, qoa,
	}
	let ctx = new OfflineAudioContext(1, 128, 44100)
	await ctx.audioWorklet.addModule('./test.worklet.js')
	let node = new AudioWorkletNode(ctx, 'decode-test', { processorOptions: fixtures })
	let report = await new Promise(resolve => {
		let timer = setTimeout(() => resolve({ error: 'AudioWorklet timeout' }), 30000)
		let done = value => { clearTimeout(timer); resolve(value) }
		node.port.onmessage = event => done(event.data)
		node.onprocessorerror = () => done({ error: 'AudioWorklet processor error' })
	})
	is(report.error, undefined, 'no error')
	is(report.globals, Object.fromEntries(['Blob', 'TextDecoder', 'atob', 'Worker', 'URL', 'fetch', 'performance', 'setTimeout'].map(name => [name, 'undefined'])), 'restricted globals')
	is(report.flac, [workletEmpty, workletEmpty, workletPCM.flacA, workletPCM.flacA, workletPCM.flacB], 'FLAC null → empty → compact Ogg A → A → raw B')
	is(report.vorbis, [workletEmpty, workletEmpty, workletPCM.vorbisA, workletPCM.vorbisA, workletPCM.vorbisB], 'Vorbis null → empty → compact stereo A → A → full mono B')
	is(report.mp3, [workletEmpty, workletEmpty, workletPCM.mp3], 'MP3 null → empty → full MPEG stream')
	is(report.opus, [workletEmpty, workletEmpty, workletPCM.opusBody, workletPCM.opusTail], 'Opus null → empty → Ogg body → flush tail')
	is(report.webmOpus, [workletEmpty, workletEmpty, workletPCM.webmOpus, workletEmpty], 'WebM Opus null → empty → file → flush')
	is(report.webmVorbis, [workletEmpty, workletEmpty, workletPCM.webmVorbisBody, workletPCM.webmVorbisTail], 'WebM Vorbis null → empty → body → flush tail')
	is(report.aac, [workletEmpty, workletEmpty, workletPCM.aac, workletEmpty], 'AAC null → empty → ADTS → flush')
	is(report.m4a, [workletEmpty, workletEmpty, workletPCM.m4a, workletEmpty], 'AAC null → empty → M4A → flush')
	is(report.alac, [workletEmpty, workletEmpty, workletPCM.alac, workletEmpty], 'ALAC null → empty → M4A → flush')
	is(report.amrNb, [workletEmpty, workletEmpty, workletPCM.amrNb, workletEmpty], 'AMR-NB null → empty → silent file → flush')
	is(report.amrWb, [workletEmpty, workletEmpty, workletPCM.amrWb, workletEmpty], 'AMR-WB null → empty → file → flush')
	is(report.wmaMono, [workletEmpty, workletEmpty, workletPCM.wmaMono, workletEmpty], 'WMA mono null → empty → file → flush')
	is(report.wmaStereo, [workletEmpty, workletEmpty, workletPCM.wmaStereo, workletEmpty], 'WMA stereo null → empty → file → flush')
	is(report.splits.opus, [workletPCM.opusBody, workletEmpty, workletPCM.opusTail], 'Opus split before final byte → flush tail')
	is(report.splits.aac, [workletAudio(1, 541696, 44100), workletAudio(1, 1024, 44100), workletEmpty], 'AAC split before final byte → final frame')
	is(report.splits.amrNb, [workletAudio(1, 7840, 8000, false), workletAudio(1, 160, 8000, false), workletEmpty], 'AMR-NB split before final byte → final frame')
	is(report.splits.wmaMono, [workletAudio(1, 32768, 44100), workletAudio(1, 12288, 44100), workletEmpty], 'WMA split before final byte → final packet')
	let whole = {
		flac: workletPCM.flacB,
		vorbis: workletPCM.vorbisB,
		mp3: workletPCM.mp3,
		opus: workletAudio(1, 589044, 48000),
		webmOpus: workletPCM.webmOpus,
		webmVorbis: workletAudio(1, 542144, 44100),
		aac: workletPCM.aac,
		m4a: workletPCM.m4a,
		alac: workletPCM.alac,
		amrNb: workletPCM.amrNb,
		amrWb: workletPCM.amrWb,
		wmaMono: workletPCM.wmaMono,
		wmaStereo: workletPCM.wmaStereo,
	}
	for (let [name, expected] of Object.entries(whole)) is(report.whole[name], { promised: true, ...expected }, name + ' whole-file export')
	for (let name of ['wav', 'aiff', 'caf', 'qoa']) is(report[name], workletPCM[name], name)
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
	let dec = await decode.aac()
	let r = await dec(new Uint8Array(aac))
	is(r.channelData[0].length > 0, true)
	await dec()
})

t('stream amr', async () => {
	let dec = await decode.amr()
	let r = await dec(new Uint8Array(amrNb))
	is(r.channelData[0].length > 0, true)
	await dec()
})

t('stream wma', async () => {
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
	async function* gen() { yield new Uint8Array(m4a) }
	let total = 0
	for await (let r of decode(gen(), 'm4a')) {
		is(r.sampleRate, 44100)
		total += r.channelData[0].length
	}
	is(total > 0, true)
})

t('decode m4a chunked', async () => {
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
	let ref = await decode(m4a)
	let { total, sr } = await streamTotal(chunked(m4a, 16384), 'm4a')
	is(sr, 44100)
	is(total, ref.channelData[0].length, 'buffered M4A matches one-shot')
})

t('chunked stream aac', async () => {
	let ref = await decode(aac)
	let { total, sr } = await streamTotal(chunked(aac, 4096), 'aac')
	is(sr, ref.sampleRate)
	is(near(total, ref.channelData[0].length, ref.channelData[0].length * 0.01), true, 'ADTS samples ~match')
})

t('chunked stream amr', async () => {
	let ref = await decode(amrNb)
	let { total, sr } = await streamTotal(chunked(amrNb, 1024), 'amr')
	is(sr, 8000)
	is(total, ref.channelData[0].length, 'AMR samples match one-shot')
})

t('chunked stream wma', async () => {
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

// -- video containers: the audio track is decoded, the video track skipped --

t('video containers: mp4, mov, mkv, webm, avi', async () => {
	for (let [name, bytes] of [['mp4', videoMp4], ['mov', videoMov], ['mkv', videoMkv], ['webm', videoWebm], ['avi', videoAvi]]) {
		let r = await decode(bytes)
		is(r.channelData.length, 2, name + ' stereo')
		is(r.sampleRate, 48000, name + ' rate')
		is(near(dur(r), 0.5, 0.06), true, name + ' duration ' + dur(r).toFixed(3))
		let mid = r.channelData[0].subarray(4000, 20000) // clear of codec priming / padding
		is(near(rms(mid), 0.354, 0.02), true, name + ' rms ' + rms(mid).toFixed(3)) // 0.5-amplitude sine
	}
})

t('ac3 / dts raw streams and an AC-3 track in mkv', async () => {
	for (let [name, bytes] of [['ac3', rawAc3], ['dts', rawDts], ['mkv+ac3', videoAc3]]) {
		let r = await decode(bytes)
		is(r.channelData.length, 2, name + ' stereo')
		is(r.sampleRate, 48000, name + ' rate')
		let mid = r.channelData[1].subarray(4000, 20000)
		is(near(rms(mid), 0.354, 0.02), true, name + ' rms ' + rms(mid).toFixed(3))
	}
})

t('chunked stream mp4 / mkv / avi', async () => {
	for (let [fmt, bytes] of [['mp4', videoMp4], ['mkv', videoMkv], ['avi', videoAvi]]) {
		let chunks = []
		for (let i = 0; i < bytes.length; i += 1500) chunks.push(bytes.subarray(i, i + 1500))
		let whole = await decode(bytes), total = 0
		for await (let r of decode(chunks, fmt)) total += r.channelData[0].length
		is(total, whole.channelData[0].length, fmt + ' chunked equals whole')
	}
})
