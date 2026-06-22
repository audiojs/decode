import decode, { decoder } from './decode-opus.js'
import { parseMeta } from './meta.js'
import { readFileSync } from 'fs'
import opus from 'audio-lena/opus'

let pass = 0, fail = 0
function ok(cond, msg) {
	if (cond) { pass++; console.log('  ok', msg) }
	else { fail++; console.log('  FAIL', msg) }
}
function near(a, b, tol = 0.02) { return Math.abs(a - b) < tol }
function rms(f32) { let s = 0; for (let i = 0; i < f32.length; i++) s += f32[i] * f32[i]; return Math.sqrt(s / f32.length) }

// whole-file decode
console.log('Opus whole-file')
{
	let r = await decode(opus)
	ok(r.channelData.length >= 1, 'has channels')
	ok(r.sampleRate === 48000, 'sampleRate 48000')
	ok(near(r.channelData[0].length / r.sampleRate, 12.27), 'duration ~12.27s')
	ok(rms(r.channelData[0]) > 0.05, 'has audio content')
}

// streaming decoder
console.log('Opus streaming')
{
	let dec = await decoder()
	let buf = new Uint8Array(opus)
	let a = await dec.decode(buf)
	dec.free()
	ok((a.channelData[0]?.length || 0) > 0, 'decoded samples')
}

// ===== metadata (OpusTags) =====
console.log('Opus metadata')
{
	let { meta, sampleRate } = parseMeta(readFileSync(new URL('./fixtures/tagged.opus', import.meta.url)))
	ok(sampleRate === 48000, 'sampleRate 48000 (Opus decode rate)')
	ok(meta.title === 'Lena Sine', 'title')
	ok(meta.artist === 'audiojs', 'artist')
	ok(meta.album === 'Fixtures', 'album')
	ok(meta.track === '3', 'track (from TRACKNUMBER)')
	ok(Array.isArray(meta.pictures), 'pictures array present')
	ok(parseMeta(new Uint8Array([1, 2, 3, 4])) === null, 'non-ogg → null')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
