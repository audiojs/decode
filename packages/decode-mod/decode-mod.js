/**
 * Tracker module renderer — libopenmpt (MOD, XM, S3M, IT, MPTM, and everything else
 * libopenmpt reads: 669, AMF, AMS, C67, DBM, DIGI, DMF, DSM, DTM, FAR, FMT, FTM, GDM,
 * ICE, IMF, ITP, J2B, MDL, MED, MO3*, MT2, MTM, MUS, OKT, PLM, PSM, PT36, PTM, PUMA,
 * RTM, SFX, STM, STP, SYMMOD, ULT, UMX, WOW — see openmpt_get_supported_extensions())
 * compiled to a single-file WASM ES module. A module is a whole file, not a stream:
 * there is no meaningful partial parse of a truncated MOD/XM/S3M/IT, so decode() always
 * needs the complete file — see decoder() below.
 *
 * *MO3 needs either an external unmo3 or the bundled minimp3/stb_vorbis/miniz fallback
 * decoders; none of those ship here (see build.sh), so MO3 files fail to load cleanly.
 *
 * let { channelData, sampleRate } = await decode(modBytes)
 * let meta = await info(modBytes)   // title, duration, channel/pattern/order counts…
 */
import createMod from './src/mod.wasm.js'

const EMPTY = Object.freeze({ channelData: [], sampleRate: 0 })
const BLOCK = 4096          // frames rendered per libopenmpt call
const MAX_DURATION_S = 600  // default cap for endless/looping songs when opts.duration is omitted

// OPENMPT_MODULE_RENDER_* — libopenmpt/libopenmpt.h
const RENDER_MASTERGAIN_MILLIBEL = 1
const RENDER_STEREOSEPARATION_PERCENT = 2
const RENDER_INTERPOLATIONFILTER_LENGTH = 3

let modP
function getMod() {
	if (modP) return modP
	let p = createMod()
	modP = p
	return p.catch(e => { modP = null; throw e })
}

function toBytes(src) { return src instanceof Uint8Array ? src : new Uint8Array(src) }

/** Load a module, throw libopenmpt's own error text on failure. Caller must destroy(). */
function open(m, bytes) {
	let ptr = m._malloc(bytes.length)
	m.HEAPU8.set(bytes, ptr)
	let mod = m._audio_mod_create(ptr, bytes.length)
	m._free(ptr)
	if (!mod) throw Error('MOD: ' + m.UTF8ToString(m._audio_mod_last_error()))
	return mod
}

function metaStr(m, mod, key) {
	let len = m.lengthBytesUTF8(key) + 1, kp = m._malloc(len)
	m.stringToUTF8(key, kp, len)
	let rp = m._audio_mod_get_metadata(mod, kp)
	m._free(kp)
	let s = m.UTF8ToString(rp)
	m._audio_mod_free_string(rp)
	return s
}

/**
 * Render a complete module to PCM.
 * @param {Uint8Array|ArrayBuffer} src
 * @param {object} [opts]
 * @param {number} [opts.sampleRate=48000]
 * @param {1|2|4} [opts.channels=2] mono / stereo / quad (L,R,RL,RR)
 * @param {number} [opts.duration] seconds to render; default is libopenmpt's own duration
 *   estimate (openmpt_module_get_duration_seconds), capped at 600 s for endless/looping songs
 * @param {0|1|2|4|8} [opts.interpolation=8] OPENMPT_MODULE_RENDER_INTERPOLATIONFILTER_LENGTH —
 *   0 internal default, 1 zero-order hold, 2 linear, 4 cubic, 8 windowed sinc (8 taps)
 * @param {number} [opts.stereoSeparation=100] percent, [0,200]
 * @param {number} [opts.gain] dB, applied as master gain
 * @returns {Promise<{channelData: Float32Array[], sampleRate: number}>}
 */
export default async function decode(src, opts) {
	let m = await getMod()
	return render(m, toBytes(src), opts)
}

function render(m, bytes, opts = {}) {
	let { sampleRate = 48000, channels = 2, duration, interpolation = 8, stereoSeparation = 100, gain } = opts
	if (channels !== 1 && channels !== 2 && channels !== 4) throw Error('MOD: channels must be 1, 2 or 4')
	let mod = open(m, bytes)
	try {
		m._audio_mod_set_repeat_count(mod, 0)
		m._audio_mod_set_render_param(mod, RENDER_INTERPOLATIONFILTER_LENGTH, interpolation)
		m._audio_mod_set_render_param(mod, RENDER_STEREOSEPARATION_PERCENT, stereoSeparation)
		if (gain != null) m._audio_mod_set_render_param(mod, RENDER_MASTERGAIN_MILLIBEL, Math.round(gain * 100))

		let capS = duration != null ? duration : Math.min(m._audio_mod_get_duration_seconds(mod), MAX_DURATION_S)
		let maxFrames = Math.ceil(capS * sampleRate)
		let bufs = Array.from({ length: channels }, () => m._malloc(BLOCK * 4))
		try {
			let parts = [], frames = 0
			while (frames < maxFrames) {
				let want = Math.min(BLOCK, maxFrames - frames)
				let n = channels === 1 ? m._audio_mod_read_mono(mod, sampleRate, want, bufs[0])
					: channels === 2 ? m._audio_mod_read_stereo(mod, sampleRate, want, bufs[0], bufs[1])
					: m._audio_mod_read_quad(mod, sampleRate, want, bufs[0], bufs[1], bufs[2], bufs[3])
				if (!n) break // song end (repeat count exhausted)
				parts.push(bufs.map(p => m.HEAPF32.slice(p >> 2, (p >> 2) + n)))
				frames += n
			}
			if (!frames) return EMPTY
			let channelData = Array.from({ length: channels }, (_, c) => {
				let o = new Float32Array(frames), off = 0
				for (let p of parts) { o.set(p[c], off); off += p[c].length }
				return o
			})
			return { channelData, sampleRate }
		} finally { for (let p of bufs) m._free(p) }
	} finally { m._audio_mod_destroy(mod) }
}

/**
 * Read module metadata without rendering audio.
 * @param {Uint8Array|ArrayBuffer} src
 */
export async function info(src) {
	let m = await getMod()
	let mod = open(m, toBytes(src))
	try {
		return {
			title: metaStr(m, mod, 'title'),
			artist: metaStr(m, mod, 'artist'),
			type: metaStr(m, mod, 'type'),
			typeLong: metaStr(m, mod, 'type_long'),
			tracker: metaStr(m, mod, 'tracker'),
			message: metaStr(m, mod, 'message'),
			duration: m._audio_mod_get_duration_seconds(mod),
			channels: m._audio_mod_get_num_channels(mod),
			patterns: m._audio_mod_get_num_patterns(mod),
			orders: m._audio_mod_get_num_orders(mod),
			instruments: m._audio_mod_get_num_instruments(mod),
			samples: m._audio_mod_get_num_samples(mod),
		}
	} finally { m._audio_mod_destroy(mod) }
}

/**
 * Whole-file decoder. A module can't be parsed from a partial buffer, so decode(chunk)
 * expects (and returns) the complete rendered file in one call; flush() has nothing left
 * to do. free() is a no-op — no WASM state outlives a single decode() call.
 */
export async function decoder(opts) {
	let m = await getMod()
	return {
		decode: (chunk) => chunk && chunk.byteLength ? render(m, toBytes(chunk), opts) : EMPTY,
		flush: () => EMPTY,
		free: () => {},
	}
}
