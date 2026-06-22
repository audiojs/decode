import decode, { decoder } from './decode-wav.js'

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

// ===== error handling =====

{
	let threw = false
	try { await decode(new Uint8Array([0, 1, 2, 3])) } catch { threw = true }
	ok(threw, 'error: rejects non-WAV')
}

{
	let threw = false
	// WAV with unsupported format (ADPCM = 0x0002)
	let buf = buildWav({ bitDepth: 16, samples: [0] })
	let v = new DataView(buf.buffer)
	v.setUint16(20, 2, true) // overwrite format id to ADPCM
	try { await decode(buf) } catch { threw = true }
	ok(threw, 'error: rejects unsupported format')
}

console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
