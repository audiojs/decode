// Fixtures:
//  1. A minimal 4-channel ProTracker "M.K." MOD is built programmatically below
//     (buildProtrackerMod) — one 32-byte sine-cycle sample, one pattern, one note.
//  2. fixtures/test.{mod,xm,s3m,mptm} are libopenmpt's own loader regression fixtures,
//     copied from lib/openmpt/test/ (see fixtures/README.md).
import t, { is, ok, almost, rejects } from 'tst'
import decode, { decoder, info } from './decode-mod.js'
import { readFileSync } from 'fs'

const fx = n => new Uint8Array(readFileSync(new URL('./fixtures/' + n, import.meta.url)))

// ── synthetic MOD ──────────────────────────────────────────────────────────
//
// ProTracker "M.K." layout (31-instrument format): title(20) + 31×sampleheader(30) +
// songlength(1) + restart(1) + orders(128) + tag(4) = 1084 header bytes, then pattern
// data (rows×channels×4 bytes/cell), then raw sample data. All multi-byte header
// fields are big-endian (Amiga byte order).
const ROWS = 64, CHANNELS = 4, SAMPLE_LEN = 32, PERIOD = 428, SPEED = 6, TEMPO = 125
// PAL Amiga Paula clock (lib/openmpt/soundlib/Paula.h: `PAULA_HZ = 3546895`, i.e.
// 7093789.2/2 Hz) — the standard ProTracker period→frequency formula: freq = PAULA_HZ / period.
const PAULA_HZ = 3546895
const NOTE_HZ = PAULA_HZ / PERIOD / SAMPLE_LEN // sample loop plays at NOTE_HZ

function buildProtrackerMod() {
	const NUM_SAMPLES = 31
	const buf = new Uint8Array(1084 + ROWS * CHANNELS * 4 + SAMPLE_LEN)
	const dv = new DataView(buf.buffer)
	let off = 20 // title, left zeroed
	for (let s = 0; s < NUM_SAMPLES; s++) {
		if (s !== 0) continue
		const base = off + s * 30
		dv.setUint16(base + 22, SAMPLE_LEN / 2, false) // sample length, in words
		buf[base + 24] = 0                             // finetune
		buf[base + 25] = 64                            // volume (max)
		dv.setUint16(base + 26, 0, false)               // repeat offset, in words
		dv.setUint16(base + 28, SAMPLE_LEN / 2, false)  // repeat length: loops the whole sample
	}
	off += NUM_SAMPLES * 30 // 950
	buf[off++] = 1 // song length: 1 order
	buf[off++] = 0 // restart position
	buf[off] = 0   // order 0 → pattern 0
	off += 128     // 1080
	buf[off++] = 0x4D; buf[off++] = 0x2E; buf[off++] = 0x4B; buf[off++] = 0x2E // "M.K."
	// pattern 0, row 0, channel 0: sample 1, period 428, no effect. Every other cell is 0
	// (no note) — ProTracker's own defaults (speed 6, tempo 125) apply throughout.
	const cell = off, sampleNum = 1
	buf[cell + 0] = (sampleNum & 0xF0) | ((PERIOD >> 8) & 0x0F)
	buf[cell + 1] = PERIOD & 0xFF
	buf[cell + 2] = (sampleNum & 0x0F) << 4
	off += ROWS * CHANNELS * 4 // 1024
	for (let i = 0; i < SAMPLE_LEN; i++) {
		const v = Math.round(96 * Math.sin(2 * Math.PI * i / SAMPLE_LEN)) // amplitude 96/128, headroom against overshoot
		buf[off + i] = v < 0 ? v + 256 : v // signed 8-bit, two's complement
	}
	return buf
}

function goertzelPower(x, freq, sr) {
	const w = 2 * Math.PI * freq / sr, c = 2 * Math.cos(w)
	let s1 = 0, s2 = 0
	for (let i = 0; i < x.length; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0 }
	return s1 * s1 + s2 * s2 - c * s1 * s2
}
/** Peak-search a narrow band around `around` (±50%, 0.25% steps) and return the frequency of maximum energy. */
function detectPitch(x, sr, around) {
	let best = around, bestPower = -1
	for (let f = around * 0.5; f <= around * 1.5; f += around * 0.0025) {
		const p = goertzelPower(x, f, sr)
		if (p > bestPower) { bestPower = p; best = f }
	}
	return best
}

t('synthetic MOD: pitch, duration, stereo, no clipping', async () => {
	const bytes = buildProtrackerMod()
	const r = await decode(bytes)
	is(r.channelData.length, 2, 'stereo by default')

	const dur = r.channelData[0].length / r.sampleRate
	// 64 rows × (2.5/tempo × speed) s/row — standard tracker tick formula, ±1 tick tolerance
	const tick = 2.5 / TEMPO, expectDur = ROWS * tick * SPEED
	ok(Math.abs(dur - expectDur) <= tick, `duration ${dur.toFixed(4)} vs expected ${expectDur} ±${tick}`)

	let peak = 0
	for (const ch of r.channelData) for (const v of ch) peak = Math.max(peak, Math.abs(v))
	ok(peak > 0.01 && peak < 1, `peak ${peak} in (0.01, 1) — audible, not clipped`)
	ok(r.channelData[0].some(v => v !== 0) && r.channelData[1].some(v => v !== 0), 'both channels carry signal')

	const detected = detectPitch(r.channelData[0].subarray(0, 8192), r.sampleRate, NOTE_HZ)
	ok(Math.abs(detected - NOTE_HZ) / NOTE_HZ < 0.01, `pitch ${detected.toFixed(2)} Hz within 1% of ${NOTE_HZ.toFixed(2)} Hz`)
})

t('synthetic MOD: info() fields', async () => {
	const i = await info(buildProtrackerMod())
	is(i.type, 'mod')
	ok(/ProTracker/i.test(i.typeLong), 'typeLong names ProTracker: ' + i.typeLong)
	is(i.channels, CHANNELS, 'pattern channel count')
	is(i.patterns, 1)
	is(i.orders, 1)
	is(i.samples, 31, '31 sample slots — fixed by the M.K. header layout')
})

t('sampleRate and channels options honoured', async () => {
	const bytes = buildProtrackerMod()
	const r1 = await decode(bytes, { sampleRate: 22050, channels: 1 })
	is(r1.sampleRate, 22050)
	is(r1.channelData.length, 1)

	const r4 = await decode(bytes, { channels: 4 })
	is(r4.channelData.length, 4, 'quad: L,R,RL,RR')
	is(r4.channelData[0].length, r4.channelData[3].length)
})

t('duration cap works on a looping/long module', async () => {
	// test.s3m's own duration estimate is > 1200s (complex pattern jumps) — the cap must
	// truncate rendering rather than rendering the whole (impractically long) estimate.
	const r = await decode(fx('test.s3m'), { duration: 1 })
	is(r.channelData[0].length, r.sampleRate, 'exactly 1s of frames, capped')
})

t('interpolation changes output but not the detected pitch', async () => {
	const bytes = buildProtrackerMod()
	const a = await decode(bytes, { interpolation: 1 }) // zero-order hold
	const b = await decode(bytes, { interpolation: 8 }) // windowed sinc, 8 taps
	ok(a.channelData[0].some((v, i) => v !== b.channelData[0][i]), 'interpolation changes the waveform')
	const pa = detectPitch(a.channelData[0].subarray(0, 8192), a.sampleRate, NOTE_HZ)
	const pb = detectPitch(b.channelData[0].subarray(0, 8192), b.sampleRate, NOTE_HZ)
	ok(Math.abs(pa - NOTE_HZ) / NOTE_HZ < 0.01 && Math.abs(pb - NOTE_HZ) / NOTE_HZ < 0.01, 'pitch unaffected by interpolation filter')
})

t('garbage input throws with libopenmpt error text', async () => {
	const garbage = new Uint8Array(4096).map((_, i) => (i * 7) & 0xFF)
	await rejects(() => decode(garbage), /./, 'rejects')
	await rejects(() => decode(new Uint8Array(0)))
})

t('free() is idempotent', async () => {
	const dec = await decoder()
	dec.free()
	dec.free()
	ok(true, 'no throw')
})

t('decoder(): decode(all) renders, flush() is empty — whole-file shape (no chunked streaming; a module is not a stream, cf. decode-qoa)', async () => {
	const bytes = buildProtrackerMod()
	const whole = await decode(bytes)
	const dec = await decoder()
	const r = await dec.decode(bytes)
	is(r.channelData[0].length, whole.channelData[0].length)
	const f = dec.flush()
	is(f.channelData.length, 0, 'flush empty')
	dec.free()
})

// ── libopenmpt's own loader regression fixtures ─────────────────────────────

t('fixtures: info() reports the right format per file', async () => {
	const cases = [
		['test.mod', 'mod', /ProTracker/i],
		['test.xm', 'xm', /FastTracker/i],
		['test.s3m', 's3m', /Scream Tracker/i],
		['test.mptm', 'mptm', /OpenMPT/i],
	]
	for (const [file, type, typeLongRe] of cases) {
		const i = await info(fx(file))
		is(i.type, type, file + ' type')
		ok(typeLongRe.test(i.typeLong), file + ' typeLong: ' + i.typeLong)
		ok(i.channels > 0, file + ' has pattern channels')
	}
})

t('fixtures: test.mod and test.s3m render non-silent audio of their reported duration', async () => {
	// test.xm and test.mptm are OpenMPT's loader *parsing* regression fixtures (instrument
	// envelope alignment, pattern note-range edge cases…) and are silent by design when
	// played back — verified directly against the WASM render, not assumed.
	for (const file of ['test.mod', 'test.s3m']) {
		const i = await info(fx(file))
		const capped = Math.min(i.duration, 8) // test.s3m's own estimate is 1200+ s
		const r = await decode(fx(file), { duration: capped })
		almost(r.channelData[0].length / r.sampleRate, capped, 0.05, file + ' duration')
		let peak = 0
		for (const ch of r.channelData) for (const v of ch) peak = Math.max(peak, Math.abs(v))
		ok(peak > 0, file + ' non-silent, peak ' + peak)
	}
})
