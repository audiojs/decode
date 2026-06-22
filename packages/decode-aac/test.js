import { readFileSync } from 'fs'
import decode, { decoder } from './decode-aac.js'
import { parseMeta } from './meta.js'

let pass = 0, fail = 0
function ok(cond, msg) {
	if (cond) { pass++; console.log('  ok', msg) }
	else { fail++; console.log('  FAIL', msg) }
}
function near(a, b, tol = 0.02) { return Math.abs(a - b) < tol }
function rms(f32) { let s = 0; for (let i = 0; i < f32.length; i++) s += f32[i] * f32[i]; return Math.sqrt(s / f32.length) }

let m4a = readFileSync(new URL('lena.m4a', import.meta.resolve('audio-lena')))
let aac = readFileSync(new URL('lena.aac', import.meta.resolve('audio-lena')))

// ---- M4A decode ----
console.log('M4A decode')
{
	let r = await decode(m4a)
	ok(r.channelData.length === 2, 'stereo')
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(near(r.channelData[0].length / r.sampleRate, 12.28, 0.05), 'duration ~12.28s')
	ok(rms(r.channelData[0]) > 0.05, 'has audio content')
	// verify no NaN/Inf
	let bad = 0
	for (let ch of r.channelData) for (let i = 0; i < ch.length; i++) if (!isFinite(ch[i])) bad++
	ok(bad === 0, 'no NaN/Inf in output')
}

// ---- ADTS decode ----
console.log('ADTS decode')
{
	let r = await decode(aac)
	ok(r.channelData.length >= 1, 'has channels (' + r.channelData.length + ')')
	ok(r.sampleRate === 44100, 'sampleRate 44100')
	ok(r.channelData[0].length > 100000, 'has samples (' + r.channelData[0].length + ')')
	ok(rms(r.channelData[0]) > 0.05, 'has audio content')
	// no NaN
	let bad = 0
	for (let i = 0; i < r.channelData[0].length; i++) if (!isFinite(r.channelData[0][i])) bad++
	ok(bad === 0, 'no NaN/Inf')
}

// ---- Stereo separation ----
console.log('stereo separation')
{
	let r = await decode(m4a)
	let diff = 0
	for (let i = 0; i < Math.min(1000, r.channelData[0].length); i++)
		diff += Math.abs(r.channelData[0][i] - r.channelData[1][i])
	ok(diff > 0.001, 'L/R channels differ')
}

// ---- Sequential determinism ----
console.log('sequential determinism')
{
	let r1 = await decode(m4a)
	let r2 = await decode(m4a)
	ok(r1.channelData[0].length === r2.channelData[0].length, 'same length')
	ok(r1.sampleRate === r2.sampleRate, 'same sampleRate')
	let maxDiff = 0
	for (let i = 0; i < r1.channelData[0].length; i++)
		maxDiff = Math.max(maxDiff, Math.abs(r1.channelData[0][i] - r2.channelData[0][i]))
	ok(maxDiff === 0, 'identical output')
}

// ---- Concurrent decoders ----
console.log('concurrent decoders')
{
	let [r1, r2] = await Promise.all([decode(m4a), decode(m4a)])
	ok(r1.channelData[0].length === r2.channelData[0].length, 'same length')
}

// ---- Lifecycle ----
console.log('lifecycle')
{
	// decode after free throws
	let d = await decoder()
	d.free()
	let threw = false
	try { d.decode(new Uint8Array(m4a)) } catch { threw = true }
	ok(threw, 'decode after free throws')

	// double free is safe
	d = await decoder()
	d.decode(new Uint8Array(m4a))
	d.free()
	d.free()
	ok(true, 'double free ok')

	// flush returns EMPTY
	d = await decoder()
	d.decode(new Uint8Array(m4a))
	let f = d.flush()
	ok(f.channelData.length === 0, 'flush returns EMPTY')
	d.free()
}

// ---- M4A streaming (moov split across chunks, non-faststart layout) ----
// Regression: github #44 — init fired on partial moov → garbage stsz/stco → 0 frames.
console.log('M4A streaming')
{
	let ref = await decode(m4a)

	for (let chunkSize of [16384, 4096, 1024, 256]) {
		let dec = await decoder()
		let chunks = []
		for (let off = 0; off < m4a.length; off += chunkSize) {
			let r = dec.decode(m4a.subarray(off, Math.min(off + chunkSize, m4a.length)))
			if (r.channelData.length) chunks.push(r.channelData[0])
		}
		let f = dec.flush()
		if (f.channelData.length) chunks.push(f.channelData[0])
		dec.free()

		let total = chunks.reduce((s, c) => s + c.length, 0)
		ok(total === ref.channelData[0].length, 'chunk=' + chunkSize + ' count matches (' + total + ')')

		let stream = new Float32Array(total), pos = 0
		for (let c of chunks) { stream.set(c, pos); pos += c.length }
		let maxDiff = 0
		for (let i = 0; i < total; i++) maxDiff = Math.max(maxDiff, Math.abs(stream[i] - ref.channelData[0][i]))
		ok(maxDiff === 0, 'chunk=' + chunkSize + ' content identical')
	}
}

// ---- M4A streaming, faststart layout (moov before mdat) ----
// Regression: github #45 — when init parses moov early with no room for first frame,
// _left stayed null and subsequent chunks misaligned, yielding 0 frames.
console.log('M4A streaming (faststart)')
{
	// Build faststart variant: ftyp + moov + mdat, with stco offsets rewritten.
	let r32 = (b, o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0
	let w32 = (b, o, v) => { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255 }
	let src = new Uint8Array(m4a), boxes = {}, off = 0
	while (off < src.length - 8) {
		let sz = r32(src, off)
		let t = String.fromCharCode(src[off + 4], src[off + 5], src[off + 6], src[off + 7])
		boxes[t] = { off, sz }
		off += sz
	}
	let moov = src.slice(boxes.moov.off, boxes.moov.off + boxes.moov.sz)
	let mdat = src.subarray(boxes.mdat.off, boxes.mdat.off + boxes.mdat.sz)
	let newMdatOff = boxes.ftyp.sz + moov.length
	let delta = newMdatOff - boxes.mdat.off
	for (let i = 0; i < moov.length - 4; i++) {
		let t = String.fromCharCode(moov[i], moov[i + 1], moov[i + 2], moov[i + 3])
		if (t === 'stco') {
			let n = r32(moov, i + 8)
			for (let k = 0; k < n; k++) w32(moov, i + 12 + k * 4, r32(moov, i + 12 + k * 4) + delta)
		}
	}
	let fast = new Uint8Array(boxes.ftyp.sz + moov.length + mdat.length)
	fast.set(src.subarray(0, boxes.ftyp.sz), 0)
	fast.set(moov, boxes.ftyp.sz)
	fast.set(mdat, newMdatOff)

	let ref = await decode(fast)
	ok(ref.channelData[0].length > 0, 'faststart whole-file decodes')

	// 64-byte chunks: moov spans many chunks AND first frame can't fit at init time.
	for (let chunkSize of [16384, 1024, 256, 64]) {
		let dec = await decoder()
		let chunks = []
		for (let off = 0; off < fast.length; off += chunkSize) {
			let r = dec.decode(fast.subarray(off, Math.min(off + chunkSize, fast.length)))
			if (r.channelData.length) chunks.push(r.channelData[0])
		}
		let f = dec.flush()
		if (f.channelData.length) chunks.push(f.channelData[0])
		dec.free()

		let total = chunks.reduce((s, c) => s + c.length, 0)
		ok(total === ref.channelData[0].length, 'chunk=' + chunkSize + ' count matches (' + total + ')')

		let stream = new Float32Array(total), pos = 0
		for (let c of chunks) { stream.set(c, pos); pos += c.length }
		let maxDiff = 0
		for (let i = 0; i < total; i++) maxDiff = Math.max(maxDiff, Math.abs(stream[i] - ref.channelData[0][i]))
		ok(maxDiff === 0, 'chunk=' + chunkSize + ' content identical')
	}
}

// ---- ADTS streaming (partial frame buffering) ----
console.log('ADTS streaming')
{
	let ref = await decode(aac)

	for (let chunkSize of [100, 300]) {
		let dec = await decoder()
		let chunks = []
		for (let off = 0; off < aac.length; off += chunkSize) {
			let r = dec.decode(aac.subarray(off, Math.min(off + chunkSize, aac.length)))
			if (r.channelData.length) chunks.push(r.channelData[0])
		}
		let f = dec.flush()
		if (f.channelData.length) chunks.push(f.channelData[0])
		dec.free()

		let total = chunks.reduce((s, c) => s + c.length, 0)
		ok(total === ref.channelData[0].length, 'chunk=' + chunkSize + ' count matches (' + total + ')')

		// verify content matches one-shot
		let stream = new Float32Array(total), pos = 0
		for (let c of chunks) { stream.set(c, pos); pos += c.length }
		let maxDiff = 0
		for (let i = 0; i < total; i++) maxDiff = Math.max(maxDiff, Math.abs(stream[i] - ref.channelData[0][i]))
		ok(maxDiff === 0, 'chunk=' + chunkSize + ' content identical (maxDiff=' + maxDiff + ')')
	}
}

// ---- Edge cases ----
console.log('edge cases')
{
	// empty input
	let d = await decoder()
	let r = d.decode(new Uint8Array(0))
	ok(r.channelData.length === 0, 'empty input → EMPTY')
	d.free()

	// null input
	d = await decoder()
	r = d.decode(null)
	ok(r.channelData.length === 0, 'null input → EMPTY')
	d.free()

	// garbage input
	d = await decoder()
	let garbage = new Uint8Array(1000)
	crypto.getRandomValues(garbage)
	try {
		r = d.decode(garbage)
		ok(r.channelData.length === 0, 'garbage → EMPTY or error')
	} catch {
		ok(true, 'garbage → threw (ok)')
	}
	d.free()

	// truncated M4A (ftyp header only)
	d = await decoder()
	r = d.decode(new Uint8Array(m4a.subarray(0, 500)))
	ok(r.channelData.length === 0, 'truncated M4A → EMPTY')
	d.free()

	// ArrayBuffer input
	r = await decode(m4a.buffer.slice(m4a.byteOffset, m4a.byteOffset + m4a.length))
	ok(r.channelData.length === 2, 'ArrayBuffer input works')
}

// ---- Performance ----
console.log('performance')
{
	// warmup
	await decode(m4a)
	let t0 = performance.now(), N = 10
	for (let i = 0; i < N; i++) await decode(m4a)
	let ms = (performance.now() - t0) / N
	ok(ms < 200, 'M4A decode < 200ms (' + ms.toFixed(1) + 'ms)')
	console.log('  ' + ms.toFixed(1) + 'ms/decode (249KB, 12.3s audio)')
}

// ===== metadata (iTunes ilst tags) =====
console.log('M4A metadata')
{
	let { meta, sampleRate } = parseMeta(readFileSync(new URL('./fixtures/tagged.m4a', import.meta.url)))
	ok(sampleRate === 44100, 'sampleRate from mp4a box')
	ok(meta.title === 'Lena Sine', 'title (©nam)')
	ok(meta.artist === 'audiojs', 'artist (©ART)')
	ok(meta.album === 'Fixtures', 'album (©alb)')
	ok(meta.year === '2026', 'year (©day)')
	ok(meta.genre === 'Test', 'genre (©gen)')
	ok(meta.track === '3', 'track (trkn)')
	ok(meta.pictures.length === 1 && meta.pictures[0].mime === 'image/png', 'cover art (covr)')
	ok(parseMeta(new Uint8Array([0, 0, 0, 8, 1, 2, 3, 4])) === null, 'non-MP4 → null')
}

console.log(`\n${pass + fail} tests, ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
