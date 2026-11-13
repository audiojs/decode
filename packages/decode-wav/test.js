import decode, { decoder } from './decode-wav.js'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
function ok(cond, msg) {
	if (cond) { pass++; console.log('  ok', msg) }
	else { fail++; console.log('  FAIL', msg) }
}
function near(a, b, tol = 0.0001) { return Math.abs(a - b) < tol }

// ===== WAV fixture builder =====

function buildWav({ sr = 44100, ch = 1, bitDepth = 16, float = false, samples }) {
	let formatId = float ? 3 : 1
	let byteDepth = bitDepth / 8
	let dataSize = samples.length * byteDepth
	let buf = new ArrayBuffer(44 + dataSize)
	let v = new DataView(buf), p = 0
	let s = (str) => { for (let i = 0; i < str.length; i++) { v.setUint8(p++, str.charCodeAt(i)) } }
	let u16 = (x) => { v.setUint16(p, x, true); p += 2 }
	let u32 = (x) => { v.setUint32(p, x, true); p += 4 }

	s('RIFF'); u32(36 + dataSize); s('WAVE')
	s('fmt '); u32(16); u16(formatId); u16(ch); u32(sr)
	u32(sr * ch * byteDepth); u16(ch * byteDepth); u16(bitDepth)
	s('data'); u32(dataSize)

	let dv = new DataView(buf, 44)
	for (let i = 0; i < samples.length; i++) {
		let s = samples[i]
		if (bitDepth === 8)       dv.setUint8(i, Math.round(s * 127 + 128))
		else if (bitDepth === 16) dv.setInt16(i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true)
		else if (bitDepth === 24) {
			let v = Math.round(s < 0 ? s * 8388608 : s * 8388607)
			if (v < 0) v += 0x1000000
			dv.setUint8(i * 3, v & 0xFF)
			dv.setUint8(i * 3 + 1, (v >> 8) & 0xFF)
			dv.setUint8(i * 3 + 2, (v >> 16) & 0xFF)
		} else if (bitDepth === 32 && !float) dv.setInt32(i * 4, Math.round(s < 0 ? s * 2147483648 : s * 2147483647), true)
		else if (bitDepth === 32 && float)  dv.setFloat32(i * 4, s, true)
		else if (bitDepth === 64 && float)  dv.setFloat64(i * 8, s, true)
	}
	return new Uint8Array(buf)
}

// sine wave samples
function sine(n, freq = 440, sr = 44100) {
	return Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * freq * i / sr))
}

// ===== bit depth round-trips =====

let signal = sine(1000)

{
	let wav = buildWav({ bitDepth: 8, samples: signal })
	let r = await decode(wav)
	ok(r.channelData.length === 1, '8-bit: mono')
	ok(r.sampleRate === 44100, '8-bit: sampleRate')
	ok(r.channelData[0].length === 1000, '8-bit: frames')
	ok(near(r.channelData[0][100], signal[100], 0.01), '8-bit: value (low precision expected)')
}

{
	let wav = buildWav({ bitDepth: 16, samples: signal })
	let r = await decode(wav)
	ok(r.channelData.length === 1, '16-bit: mono')
	ok(r.sampleRate === 44100, '16-bit: sampleRate')
	ok(r.channelData[0].length === 1000, '16-bit: frames')
	ok(near(r.channelData[0][100], signal[100], 0.00005), '16-bit: value')
}

{
	let wav = buildWav({ bitDepth: 24, samples: signal })
	let r = await decode(wav)
	ok(r.channelData.length === 1, '24-bit: mono')
	ok(r.channelData[0].length === 1000, '24-bit: frames')
	ok(near(r.channelData[0][100], signal[100], 0.000001), '24-bit: value')
}

{
	let wav = buildWav({ bitDepth: 32, samples: signal })
	let r = await decode(wav)
	ok(r.channelData.length === 1, '32-bit int: mono')
	ok(r.channelData[0].length === 1000, '32-bit int: frames')
	ok(near(r.channelData[0][100], signal[100], 0.000001), '32-bit int: value')
}

{
	let wav = buildWav({ bitDepth: 32, float: true, samples: signal })
	let r = await decode(wav)
	ok(r.channelData.length === 1, '32-bit float: mono')
	ok(r.channelData[0].length === 1000, '32-bit float: frames')
	ok(near(r.channelData[0][100], signal[100], 0.000001), '32-bit float: value')
}

{
	let wav = buildWav({ bitDepth: 64, float: true, samples: signal })
	let r = await decode(wav)
	ok(r.channelData.length === 1, '64-bit float: mono')
	ok(r.channelData[0].length === 1000, '64-bit float: frames')
	ok(near(r.channelData[0][100], signal[100], 0.000001), '64-bit float: value')
}

// ===== sync API =====

{
	let wav = buildWav({ ch: 2, bitDepth: 16, samples: sine(500).flatMap((v, i) => [v, v]) })
	let r = decode(wav)
	ok(!(r instanceof Promise), 'decode returns value, not promise')
	ok(r.channelData.length === 2, 'decode: stereo channels')
	ok(r.channelData[0].length === 500, 'decode: frames')

	let dec = decoder()
	ok(!(dec instanceof Promise), 'decoder returns instance, not promise')
	let bytes = new Uint8Array(wav)
	let half = bytes.length >> 1
	let a = dec.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + half))
	let b = dec.decode(bytes.subarray(half))
	dec.free()
	let total = (a.channelData[0]?.length || 0) + (b.channelData[0]?.length || 0)
	ok(total === 500, 'decoder: chunked ArrayBuffer decode complete')
}

// ===== stereo =====

{
	let l = sine(500, 440), r = sine(500, 880)
	let interleaved = l.flatMap((v, i) => [v, r[i]])
	let wav = buildWav({ ch: 2, bitDepth: 16, samples: interleaved })
	let res = await decode(wav)
	ok(res.channelData.length === 2, 'stereo: channels')
	ok(res.channelData[0].length === 500, 'stereo: frames')
	ok(near(res.channelData[0][100], l[100], 0.00005), 'stereo: left channel')
	ok(near(res.channelData[1][100], r[100], 0.00005), 'stereo: right channel')
}

// ===== boundary values =====

{
	// +1.0 and -1.0
	let wav = buildWav({ bitDepth: 16, samples: [1, -1, 0] })
	let r = await decode(wav)
	ok(near(r.channelData[0][0], 1, 0.00005), 'boundary: +1.0 (16-bit)')
	ok(near(r.channelData[0][1], -1, 0.00001), 'boundary: -1.0 (16-bit)')
	ok(r.channelData[0][2] === 0, 'boundary: 0.0 (16-bit)')
}

{
	// 24-bit min value: 0x800000 must decode to exactly -1.0
	let wav = buildWav({ bitDepth: 24, samples: [-1, 1, 0] })
	let r = await decode(wav)
	ok(near(r.channelData[0][0], -1, 0.000001), 'boundary: -1.0 (24-bit)')
	ok(near(r.channelData[0][1], 1, 0.000001), 'boundary: +1.0 (24-bit)')
}

// ===== extra chunks before data (JUNK chunk) =====

{
	// JUNK chunk between fmt and data
	let junkData = new Uint8Array(10)
	let signal = sine(100)
	let dataSize = signal.length * 2
	let totalSize = 4 + (8 + 16) + (8 + 10) + (8 + dataSize)
	let buf = new ArrayBuffer(8 + totalSize)
	let v = new DataView(buf), p = 0
	let s = (str) => { for (let i = 0; i < str.length; i++) v.setUint8(p++, str.charCodeAt(i)) }
	let u16 = (x) => { v.setUint16(p, x, true); p += 2 }
	let u32 = (x) => { v.setUint32(p, x, true); p += 4 }
	s('RIFF'); u32(totalSize); s('WAVE')
	s('fmt '); u32(16); u16(1); u16(1); u32(44100); u32(88200); u16(2); u16(16)
	s('JUNK'); u32(10); p += 10
	s('data'); u32(dataSize)
	let dv = new DataView(buf, p)
	for (let i = 0; i < signal.length; i++) dv.setInt16(i * 2, Math.round(signal[i] * 32767), true)
	let r = await decode(new Uint8Array(buf))
	ok(r.channelData[0].length === 100, 'extra chunk: frames correct')
	ok(near(r.channelData[0][50], signal[50], 0.00005), 'extra chunk: values correct')
}

// ===== trailing chunks after data (#47) — must not be read as audio =====

{
	// data chunk followed by a metadata chunk (e.g. LIST/cue/bext)
	let signal = sine(100)
	let dataSize = signal.length * 2
	let junkSize = 40 // bytes of trailing chunk payload read as audio before the fix
	let totalSize = 4 + (8 + 16) + (8 + dataSize) + (8 + junkSize)
	let buf = new ArrayBuffer(8 + totalSize)
	let v = new DataView(buf), p = 0
	let s = (str) => { for (let i = 0; i < str.length; i++) v.setUint8(p++, str.charCodeAt(i)) }
	let u16 = (x) => { v.setUint16(p, x, true); p += 2 }
	let u32 = (x) => { v.setUint32(p, x, true); p += 4 }
	s('RIFF'); u32(totalSize); s('WAVE')
	s('fmt '); u32(16); u16(1); u16(1); u32(44100); u32(88200); u16(2); u16(16)
	s('data'); u32(dataSize)
	let dv = new DataView(buf, p)
	for (let i = 0; i < signal.length; i++) dv.setInt16(i * 2, Math.round(signal[i] * 32767), true)
	p += dataSize
	s('LIST'); u32(junkSize); for (let i = 0; i < junkSize; i++) v.setUint8(p++, 0x55)
	let r = await decode(new Uint8Array(buf))
	ok(r.channelData[0].length === 100, 'trailing chunk: frames capped to data size')

	// same, fed through the streaming decoder one byte-region at a time
	let dec = await decoder()
	let full = new Uint8Array(buf)
	let mid = Math.floor(full.length / 2)
	let n = dec.decode(full.subarray(0, mid)).channelData[0]?.length || 0
	n += dec.decode(full.subarray(mid)).channelData[0]?.length || 0
	dec.free()
	ok(n === 100, 'trailing chunk: streaming also capped')
}

// ===== streaming decoder =====

{
	let wav = buildWav({ bitDepth: 16, samples: sine(200) })
	let dec = await decoder()
	let r = dec.decode(wav)
	ok(r.channelData[0].length === 200, 'stream: decode')
	ok(dec.flush().sampleRate === 0, 'stream: flush returns EMPTY')
	dec.free()
	let threw = false
	try { dec.decode(wav) } catch { threw = true }
	ok(threw, 'stream: throws after free')
}

// ===== WAVE_FORMAT_EXTENSIBLE (0xFFFE) =====

function buildExtensibleWav({ sr = 44100, ch = 1, bitDepth = 16, subFormat = 1, samples }) {
	let byteDepth = bitDepth / 8, dataSize = samples.length * byteDepth, fmtSize = 40
	let buf = new ArrayBuffer(12 + 8 + fmtSize + 8 + dataSize)
	let v = new DataView(buf), p = 0
	let s = (str) => { for (let i = 0; i < str.length; i++) v.setUint8(p++, str.charCodeAt(i)) }
	let u16 = (x) => { v.setUint16(p, x, true); p += 2 }
	let u32 = (x) => { v.setUint32(p, x, true); p += 4 }
	s('RIFF'); u32(4 + 8 + fmtSize + 8 + dataSize); s('WAVE')
	s('fmt '); u32(fmtSize)
	u16(0xFFFE); u16(ch); u32(sr); u32(sr * ch * byteDepth); u16(ch * byteDepth); u16(bitDepth)
	u16(22); u16(bitDepth); u32(ch === 1 ? 0x4 : 0x3) // cbSize, validBits, channelMask
	// SubFormat GUID: first 2 bytes = format tag, then standard KSDATAFORMAT suffix
	for (let byte of [subFormat & 0xFF, subFormat >> 8, 0, 0, 0, 0, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71]) v.setUint8(p++, byte)
	s('data'); u32(dataSize)
	let dv = new DataView(buf, p)
	for (let i = 0; i < samples.length; i++) dv.setInt16(i * 2, Math.round(samples[i] < 0 ? samples[i] * 32768 : samples[i] * 32767), true)
	return new Uint8Array(buf)
}

{
	let sig = sine(1000)
	let ext = await decode(buildExtensibleWav({ bitDepth: 16, samples: sig }))
	let plain = await decode(buildWav({ bitDepth: 16, samples: sig }))
	ok(ext.sampleRate === 44100, 'extensible: sampleRate')
	ok(ext.channelData[0].length === 1000, 'extensible: frames')
	let same = ext.channelData[0].every((x, i) => x === plain.channelData[0][i])
	ok(same, 'extensible PCM decodes identically to standard PCM')
	// extensible IEEE float (subformat 0x0003)
	let extF = await decode(buildExtensibleWav({ bitDepth: 16, subFormat: 3, samples: sig }))
	ok(extF.channelData.length === 1, 'extensible float subformat parses')
}

// ===== G.711 A-law / µ-law (real ffmpeg fixtures) =====

function corr(a, b) {
	let n = Math.min(a.length, b.length), sa = 0, sb = 0, sab = 0
	for (let i = 0; i < n; i++) { sa += a[i] * a[i]; sb += b[i] * b[i]; sab += a[i] * b[i] }
	return sab / Math.sqrt(sa * sb)
}

for (let name of ['alaw', 'mulaw']) {
	let buf = new Uint8Array(readFileSync(new URL(`./fixtures/${name}.wav`, import.meta.url)))
	let r = await decode(buf)
	let ideal = sine(r.channelData[0].length, 440, 8000)
	ok(r.sampleRate === 8000, `${name}: sampleRate 8000`)
	ok(r.channelData.length === 1, `${name}: mono`)
	ok(r.channelData[0].length === 2000, `${name}: 2000 frames`)
	// 440Hz sine: correct decode correlates ~1; a sign flip would score ~-1
	ok(corr(r.channelData[0], ideal) > 0.97, `${name}: matches 440Hz sine (sign + scale)`)
}

// ===== ADPCM (IMA / MS), real ffmpeg fixtures, bit-exact =====

for (let name of ['ima_mono', 'ms_mono', 'ima_stereo', 'ms_stereo']) {
	let buf = new Uint8Array(readFileSync(new URL(`./fixtures/${name}.wav`, import.meta.url)))
	let r = await decode(buf)
	let nCh = name.includes('stereo') ? 2 : 1
	ok(r.sampleRate === 22050, `${name}: sampleRate 22050`)
	ok(r.channelData.length === nCh, `${name}: ${nCh}ch`)
	ok(r.channelData[0].length > 10000, `${name}: decoded samples`)
	// ch0 is a 440Hz sine; for stereo ch1 is 660Hz — validates per-channel nibble mapping.
	// window inside the real audio (ADPCM pads the final block past the 11025-sample source)
	let win = 11000
	ok(corr(r.channelData[0].subarray(0, win), sine(win, 440, 22050)) > 0.99, `${name}: ch0 ≈ 440Hz`)
	if (nCh === 2) ok(corr(r.channelData[1].subarray(0, win), sine(win, 660, 22050)) > 0.99, `${name}: ch1 ≈ 660Hz`)
}

// ===== sample coding at every depth, data at an odd offset, streamed at odd splits =====
// Negative codes scale by 2^-(bits-1), positive by 1/(2^(bits-1) - 1), float passes through. A 3-byte chunk
// before `data` puts the samples at an odd byte offset; 3 channels make frames of odd size; splits cut frames.
{
	let oddWav = (bits, float, frames) => {
		let bps = bits / 8, nCh = frames[0].length, data = frames.length * nCh * bps
		let b = new Uint8Array(12 + 24 + 8 + 3 + 8 + data), dv = new DataView(b.buffer), p = 0
		let s = t => { for (let c of t) b[p++] = c.charCodeAt(0) }, u16 = x => { dv.setUint16(p, x, true); p += 2 }, u32 = x => { dv.setUint32(p, x, true); p += 4 }
		s('RIFF'); u32(b.length - 8); s('WAVE')
		s('fmt '); u32(16); u16(float ? 3 : 1); u16(nCh); u32(8000); u32(8000 * nCh * bps); u16(nCh * bps); u16(bits)
		s('junk'); u32(3); p += 3
		s('data'); u32(data)
		for (let f of frames) for (let v of f) {
			if (float) bits === 64 ? dv.setFloat64(p, v, true) : dv.setFloat32(p, v, true)
			else if (bits === 8) dv.setUint8(p, v)
			else if (bits === 16) dv.setInt16(p, v, true)
			else if (bits === 24) { b[p] = v & 255; b[p + 1] = v >> 8 & 255; b[p + 2] = v >> 16 & 255 }
			else dv.setInt32(p, v, true)
			p += bps
		}
		return b
	}
	let codes = { 8: [0, 255, 128, 127, 1], 16: [-32768, 32767, 0, -1, 1], 24: [-8388608, 8388607, 0, -1, 1], 32: [-2147483648, 2147483647, 0, -1, 1] }
	// v / 2^(bits-1), as ffmpeg (libswresample s16 · 1/(1<<15)), libsndfile and Web Audio's decodeAudioData
	let value = (bits, v) => { if (bits === 8) v -= 128; return v / 2 ** (bits - 1) }
	let join = parts => parts[0].map((_, c) => { let x = new Float32Array(parts.reduce((n, p) => n + p[c].length, 0)), o = 0; for (let p of parts) { x.set(p[c], o); o += p[c].length } return x })
	for (let [bits, float] of [[8, false], [16, false], [24, false], [32, false], [32, true], [64, true]]) {
		let col = float ? [1, -1, 0.25, -0.5, 3] : codes[bits], n = col.length
		let frames = col.map((v, i) => [v, col[n - 1 - i], col[(i + 2) % n]])
		let bytes = oddWav(bits, float, frames), { channelData } = decode(bytes)
		let want = c => Float32Array.from(frames, f => float ? f[c] : value(bits, f[c]))
		ok(channelData.length === 3 && channelData.every((x, c) => x.length === n && x.every((v, i) => v === want(c)[i])), `${bits}-bit ${float ? 'float' : 'int'}: every code's value, data at an odd offset`)
		for (let step of [1, 5, 7, 4096]) {
			let d = decoder(), parts = []
			for (let o = 0; o < bytes.length; o += step) { let r = d.decode(bytes.subarray(o, o + step)); if (r.channelData.length) parts.push(r.channelData) }
			let got = join(parts)
			ok(got.every((x, c) => x.length === n && x.every((v, i) => v === channelData[c][i])), `${bits}-bit ${float ? 'float' : 'int'}: streamed in ${step}-byte slices ≡ whole`)
		}
	}
}

// ===== error handling =====

{
	let threw = false
	try { await decode(new Uint8Array([0, 1, 2, 3])) } catch { threw = true }
	ok(threw, 'error: rejects non-WAV')
}

{
	let threw = false
	// WAV with a genuinely unsupported format tag (0x0099)
	let buf = buildWav({ bitDepth: 16, samples: [0] })
	let v = new DataView(buf.buffer)
	v.setUint16(20, 0x99, true)
	try { await decode(buf) } catch { threw = true }
	ok(threw, 'error: rejects unsupported format')
}

// ===== integer PCM: every 16-bit code, the 24 and 32-bit extremes, any channel count, in a Buffer off its alignment =====

{
	// a code's value: code / 2^(bits-1), whichever way it is decoded (the kernel or the loops)
	let n = 65536, wav = buildWav({ ch: 2, bitDepth: 16, samples: new Array(2 * n).fill(0) }), dv = new DataView(wav.buffer, 44)
	for (let i = 0; i < 2 * n; i++) dv.setUint16(i * 2, i % 2 ? 65535 - (i >> 1) : i >> 1, true)
	let [l, r] = (await decode(wav)).channelData
	ok(l.every((v, i) => v === (i << 16 >> 16) / 32768) && r.every((v, i) => v === ((65535 - i) << 16 >> 16) / 32768), '16-bit: every code, both channels')
	for (let [bits, codes] of [[24, [0x800000, 0x7fffff, 1, 0xffffff, 0]], [32, [0x80000000, 0x7fffffff, 1, 0xffffffff, 0, 0x40000041]]]) for (let ch of [1, 2, 3]) {
		let m = codes.length * 7, w = buildWav({ ch, bitDepth: bits, samples: new Array(m * ch).fill(0) }), d = new DataView(w.buffer, 44), bps = bits / 8
		for (let i = 0; i < m * ch; i++) { let c = codes[i % codes.length]; for (let j = 0; j < bps; j++) d.setUint8(i * bps + j, c >>> 8 * j & 255) }
		let got = (await decode(w)).channelData, want = i => { let c = codes[i % codes.length]; return (bits === 24 ? c << 8 >> 8 : c | 0) / 2 ** (bits - 1) }
		ok(got.length === ch && got.every((x, c) => x.every((v, f) => v === Math.fround(want(f * ch + c)))), `${bits}-bit, ${ch} channels: the extremes`)
	}
	// its data at an odd offset in a Node Buffer: decoded, not thrown (a Buffer's slice is a view, no aligned copy)
	let w32 = buildWav({ ch: 2, bitDepth: 32, samples: sine(64) }), at = Buffer.alloc(w32.length + 1)
	at.set(w32, 1)
	let r32 = await decode(at.subarray(1)), ref = await decode(w32)
	ok(r32.channelData.every((x, c) => x.every((v, i) => v === ref.channelData[c][i])), '32-bit: a Buffer off its alignment')
	let f64 = buildWav({ bitDepth: 64, float: true, samples: sine(64) }), b64 = Buffer.alloc(f64.length + 4)
	b64.set(f64, 4)
	ok((await decode(b64.subarray(4))).channelData[0].every((v, i) => v === Math.fround(sine(64)[i])), '64-bit float: a Buffer off its alignment')
}

console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
