import decode, { decoder } from './decode-vorbis.js'
import { parseMeta } from './meta.js'
import { readFileSync } from 'fs'
import ogg from 'audio-lena/ogg'

let pass = 0, fail = 0
function ok(cond, msg) {
	if (cond) { pass++; console.log('  ok', msg) }
	else { fail++; console.log('  FAIL', msg) }
}
function near(a, b, tol = 0.02) { return Math.abs(a - b) < tol }
function rms(f32) { let s = 0; for (let i = 0; i < f32.length; i++) s += f32[i] * f32[i]; return Math.sqrt(s / f32.length) }

// whole-file decode
console.log('Vorbis whole-file')
{
	let r = await decode(ogg)
	ok(r.channelData.length >= 1, 'has channels')
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(near(r.channelData[0].length / r.sampleRate, 12.27), 'duration ~12.27s')
	ok(rms(r.channelData[0]) > 0.05, 'has audio content')
}

// streaming decoder
console.log('Vorbis streaming')
{
	let dec = await decoder()
	let buf = new Uint8Array(ogg)
	let a = await dec.decode(buf)
	dec.free()
	ok((a.channelData[0]?.length || 0) > 0, 'decoded samples')
}

// ===== metadata (Vorbis comments) =====
console.log('Vorbis metadata')
{
	let { meta, sampleRate } = parseMeta(readFileSync(new URL('./fixtures/tagged.ogg', import.meta.url)))
	ok(sampleRate === 44100, 'sampleRate from id header')
	ok(meta.title === 'Lena Sine', 'title')
	ok(meta.artist === 'audiojs', 'artist')
	ok(meta.album === 'Fixtures', 'album')
	ok(meta.year === '2026', 'year (from DATE)')
	ok(meta.genre === 'Test', 'genre')
	ok(Array.isArray(meta.pictures), 'pictures array present')
	ok(parseMeta(new Uint8Array([1, 2, 3, 4])) === null, 'non-ogg → null')
}

// METADATA_BLOCK_PICTURE (cover art) — synthetic comment packet
console.log('Vorbis cover art')
{
	// build a FLAC PICTURE block: type=3, mime=image/png, no desc, 2-byte payload
	let mime = 'image/png', be = (n) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]
	let pic = [...be(3), ...be(mime.length), ...[...mime].map(c => c.charCodeAt(0)), ...be(0), ...be(0), ...be(0), ...be(0), ...be(0), ...be(2), 0xAB, 0xCD]
	let b64 = Buffer.from(pic).toString('base64')
	let kv = 'METADATA_BLOCK_PICTURE=' + b64
	let le = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]
	// comment block: vendor("") + 1 comment
	let block = [...le(0), ...le(1), ...le(kv.length), ...[...kv].map(c => c.charCodeAt(0))]
	let { parseComment } = await import('./meta.js')
	let { pictures } = parseComment(new Uint8Array(block))
	ok(pictures.length === 1, 'picture extracted')
	ok(pictures[0].mime === 'image/png', 'picture mime')
	ok(pictures[0].data.length === 2 && pictures[0].data[0] === 0xAB, 'picture payload')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
