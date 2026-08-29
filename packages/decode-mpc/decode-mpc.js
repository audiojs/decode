/**
 * Musepack (MPC) decoder — libmpcdec compiled to WASM (single-file ES module, host-neutral).
 * Decodes SV7 (`MP+`) and SV8 (`MPCK`) streams, container demuxing included (APEv2/ID3v1
 * tags and seek tables are parsed and skipped; not surfaced).
 *
 * let { channelData, sampleRate } = await decode(mpcBytes)
 *
 * let dec = await decoder()
 * let head = dec.decode(chunk1)   // synchronous; returns audio decoded from data seen so far
 * let tail = dec.flush()
 * dec.free()
 *
 * Streaming: SV7 needs only its ~30-byte fixed header before frames start decoding as bytes
 * arrive. SV8 keeps its seek table near the end of the stream (mpcenc can only patch the
 * header's pointer to it after encoding, once the final offset is known) and libmpcdec reads
 * that table during mpc_demux_init() — so an SV8 decoder only starts producing samples once
 * (near) the whole stream has been fed. Either way decode(chunk) never blocks: it returns
 * whatever it can given the bytes seen so far and picks up where it left off on the next call.
 */
import createMpc from './src/mpc.wasm.js'

const EMPTY = Object.freeze({ channelData: [], sampleRate: 0 })
// libmpcdec/internal.h MAX_FRAME_SIZE: worst-case compressed frame size. mpc_demux_decode()
// has no way to signal "not enough data yet" separately from "end of stream", and a failed
// frame decode leaves the demuxer's bit position permanently desynced (no retry). Keeping
// this many bytes buffered ahead of the reader's cursor before decoding a frame guarantees
// the reader is never asked for a short read except at genuine end of stream.
const SAFE_MARGIN = 4352

let modP
function getMod() {
	if (modP) return modP
	let p = createMpc()
	modP = p
	return p.catch(e => { modP = null; throw e })
}

/**
 * Whole-file decode
 * @param {Uint8Array|ArrayBuffer} src
 * @returns {Promise<{channelData: Float32Array[], sampleRate: number}>}
 */
export default async function decode(src) {
	let buf = src instanceof Uint8Array ? src : new Uint8Array(src)
	if (!buf.length) return EMPTY
	let dec = await decoder()
	try {
		let head = dec.decode(buf)
		let tail = dec.flush()
		if (!dec.inited) throw Error('Not a valid Musepack (MPC) stream')
		return merge(head, tail)
	} finally { dec.free() }
}

/** Create streaming decoder instance — decode() and flush() are synchronous. */
export async function decoder() {
	return new MpcDecoder(await getMod())
}

class MpcDecoder {
	constructor(m) {
		this.m = m
		this.h = m._audio_mpc_create()
		if (!this.h) throw Error('MPC decoder allocation failed')
		this.inited = false
		this.failed = false
		this.done = false
		this.channels = 0
		this.sampleRate = 0
		this.errors = 0
		this.ptr = 0; this.cap = 0
		this.freed = false
	}

	decode(data) {
		if (this.freed) throw Error('Decoder already freed')
		if (this.failed) throw Error('Not a valid Musepack (MPC) stream')
		if (!data || !data.byteLength) return EMPTY
		let buf = data instanceof Uint8Array ? data : new Uint8Array(data)
		let m = this.m
		let ptr = this.alloc(buf.length)
		m.HEAPU8.set(buf, ptr)
		if (m._audio_mpc_feed(this.h, ptr, buf.length) < 0) throw Error('MPC: out of WASM memory')

		if (!this.inited) {
			let r = m._audio_mpc_init(this.h)
			if (r < 0) { this.failed = true; throw Error('Not a valid Musepack (MPC) stream') }
			if (r === 0) return EMPTY // header incomplete — retry once more bytes arrive
			this.inited = true
			this.channels = m._audio_mpc_channels(this.h)
			this.sampleRate = m._audio_mpc_sample_rate(this.h)
		}
		return this.drain(false)
	}

	/** Drop the streaming state (see class doc); at real end of stream this decodes any frames the safety margin was withholding. */
	flush() {
		if (this.freed) throw Error('Decoder already freed')
		if (this.failed) throw Error('Not a valid Musepack (MPC) stream')
		if (!this.inited) {
			let r = this.m._audio_mpc_init(this.h) // one last attempt now that no more data is coming
			if (r < 0) { this.failed = true; throw Error('Not a valid Musepack (MPC) stream') }
			if (r === 0) return EMPTY // stream ended before a header could be parsed
			this.inited = true
			this.channels = this.m._audio_mpc_channels(this.h)
			this.sampleRate = this.m._audio_mpc_sample_rate(this.h)
		}
		return this.drain(true)
	}

	drain(final) {
		if (this.done) return EMPTY
		let m = this.m, parts = [], ch = this.channels
		for (; ;) {
			if (!final && m._audio_mpc_avail(this.h) < SAFE_MARGIN) break
			let n = m._audio_mpc_decode(this.h)
			if (n <= 0) { this.done = true; if (n < 0) this.errors++; break }
			let out = m._audio_mpc_output(this.h) >> 2
			parts.push(Array.from({ length: ch }, (_, c) => {
				let a = new Float32Array(n)
				for (let i = 0; i < n; i++) a[i] = m.HEAPF32[out + i * ch + c]
				return a
			}))
		}
		if (!parts.length) return EMPTY
		let total = parts.reduce((s, p) => s + p[0].length, 0)
		let channelData = Array.from({ length: ch }, (_, c) => {
			let o = new Float32Array(total), off = 0
			for (let p of parts) { o.set(p[c], off); off += p[c].length }
			return o
		})
		return { channelData, sampleRate: this.sampleRate }
	}

	free() {
		if (this.freed) return
		this.freed = true
		this.m._audio_mpc_destroy(this.h); this.h = 0
		if (this.ptr) this.m._free(this.ptr)
		this.ptr = 0; this.cap = 0
	}

	alloc(len) {
		if (len > this.cap) {
			if (this.ptr) this.m._free(this.ptr)
			this.cap = len
			this.ptr = this.m._malloc(len)
			if (!this.ptr) throw Error('MPC: out of WASM memory')
		}
		return this.ptr
	}
}

function merge(a, b) {
	if (!b?.channelData?.length) return a
	if (!a?.channelData?.length) return b
	return { channelData: a.channelData.map((ch, i) => { let m = new Float32Array(ch.length + b.channelData[i].length); m.set(ch); m.set(b.channelData[i], ch.length); return m }), sampleRate: a.sampleRate }
}
