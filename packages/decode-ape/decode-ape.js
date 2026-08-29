/**
 * Monkey's Audio (APE) decoder — FFmpeg's `ape` libavcodec decoder (LGPL-2.1-or-later) compiled to
 * a single-file WASM ES module. FFmpeg ships no standalone APE demuxer library to link against, so
 * the container (header, seek table, per-frame packet layout) is parsed here in JS, replicating
 * libavformat/ape.c's `ape_read_header` / `ape_read_packet` exactly — same field layout, same
 * seek-table/skip/size arithmetic, same [nblocks, skip, data] packet shape apedec.c expects.
 * Reference: FFmpeg 7.1 libavformat/ape.c + libavcodec/apedec.c; Monkey's Audio SDK docs
 * (https://monkeysaudio.com/developers.html).
 *
 * let { channelData, sampleRate } = await decode(apeBuf)
 * let dec = await decoder(); let result = dec.decode(chunk)
 */
import createApe from './src/ape.wasm.js'

const EMPTY = Object.freeze({ channelData: [], sampleRate: 0 })
const MIN_VERSION = 3800, MAX_VERSION = 3990
const FLAG_8BIT = 1, FLAG_HAS_PEAK = 4, FLAG_24BIT = 8, FLAG_HAS_SEEK = 16, FLAG_WAV_HEADER = 32

let modP
function getMod() {
	if (modP) return modP
	let p = createApe()
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
	let dec = await decoder()
	try { return merge(dec.decode(buf), dec.flush()) }
	finally { dec.free() }
}

/** Create streaming decoder instance — decode() and flush() are synchronous. */
export async function decoder() {
	return new APEDecoder(await getMod())
}

class APEDecoder {
	constructor(m) {
		this.m = m
		this.h = 0
		this.header = null      // parsed once the descriptor/header/seek table are all in: { channels, sampleRate, bps, extradata, frames, wavtaillength }
		this.accum = []; this.accumLen = 0
		this.idx = 0             // next frame to decode
		this.left = null; this.fileOff = 0   // buffered bytes, keyed by absolute file offset (like decode-mp4's sample walker)
		this.totalBytes = 0      // every byte received once the header is known — the final frame's size depends on total stream length
		this.ptr = 0; this.cap = 0
		this.errors = 0
		this.freed = false
	}

	decode(data) {
		if (this.freed) throw Error('Decoder already freed')
		if (!data || !data.byteLength) return EMPTY
		let buf = data instanceof Uint8Array ? data : new Uint8Array(data)

		if (this.header) {
			this.left = this.left ? append(this.left, buf) : buf.slice()
			this.totalBytes += buf.length
			return this.extract()
		}

		this.accum.push(buf); this.accumLen += buf.length
		let all = this.accum.length === 1 ? this.accum[0] : concat(this.accum, this.accumLen)
		if (all.length >= 4 && (all[0] !== 0x4D || all[1] !== 0x41 || all[2] !== 0x43 || all[3] !== 0x20))
			throw Error("Not a Monkey's Audio (APE) stream")
		let header = parseHeader(all)
		if (!header) return EMPTY // header/seek table not complete yet
		this.accum = []; this.accumLen = 0
		this.header = header

		let ep = this.alloc(6)
		this.m.HEAPU8.set(header.extradata, ep)
		this.h = this.m._audio_ape_create(header.channels, header.sampleRate, header.bps, ep)
		if (!this.h) throw Error('APE decoder allocation failed')

		this.left = all; this.fileOff = 0; this.totalBytes = all.length
		return this.extract()
	}

	// Decode every frame whose byte range is fully buffered, except the last (its length depends
	// on the stream's total size, unknowable until flush() — see there).
	extract() {
		let frames = this.header.frames, last = frames.length - 1, parts = []
		while (this.idx < last) {
			let fr = frames[this.idx], bufOff = fr.pos - this.fileOff
			if (bufOff < 0 || bufOff + fr.size > this.left.length) break
			this.decodeFrame(fr, bufOff, parts)
			this.idx++
		}
		if (this.idx < last) {
			let nextOff = frames[this.idx].pos, end = this.fileOff + this.left.length
			if (nextOff >= end) { this.fileOff = end; this.left = null }
			else if (nextOff > this.fileOff) { this.left = this.left.subarray(nextOff - this.fileOff).slice(); this.fileOff = nextOff }
		}
		return this.result(parts)
	}

	decodeFrame(fr, bufOff, parts) {
		let ptr = this.alloc(8 + fr.size), h = this.m.HEAPU8
		h[ptr] = fr.nblocks & 255; h[ptr + 1] = (fr.nblocks >>> 8) & 255; h[ptr + 2] = (fr.nblocks >>> 16) & 255; h[ptr + 3] = (fr.nblocks >>> 24) & 255
		h[ptr + 4] = fr.skip & 255; h[ptr + 5] = (fr.skip >>> 8) & 255; h[ptr + 6] = (fr.skip >>> 16) & 255; h[ptr + 7] = (fr.skip >>> 24) & 255
		h.set(this.left.subarray(bufOff, bufOff + fr.size), ptr + 8)
		let n = this.m._audio_ape_decode(this.h, ptr, 8 + fr.size, fr.nblocks)
		if (n < 0) { this.errors++; return }
		if (n > 0) {
			let out = this.m._audio_ape_output(this.h) >> 2, channels = this.header.channels
			parts.push(Array.from({ length: channels }, (_, c) => this.m.HEAPF32.slice(out + c * fr.nblocks, out + c * fr.nblocks + n)))
		}
	}

	result(parts) {
		if (!parts.length) return EMPTY
		let channels = this.header.channels
		let total = parts.reduce((s, p) => s + p[0].length, 0)
		let channelData = Array.from({ length: channels }, (_, c) => {
			let o = new Float32Array(total), off = 0
			for (let p of parts) { o.set(p[c], off); off += p[c].length }
			return o
		})
		return { channelData, sampleRate: this.header.sampleRate }
	}

	// The last frame's byte length isn't in the seek table (only the next frame's position bounds
	// a frame; there is no "next" for the last one). libavformat/ape.c derives it from the total
	// file size once known: final_size = file_size - frame.pos - wavtaillength, rounded to a
	// multiple of 4, falling back to finalframeblocks*8 if that's not positive (see ape_read_header).
	// In a stream, "file size" is exactly the byte count flush() is called with — total bytes seen.
	//
	// A stream can also end before frames[this.idx] (the next undecoded frame) fully arrived —
	// libavformat's own avio_read short-reads in that case and hands the decoder however many
	// bytes it got (ape_read_packet sets pkt->size from the actual read count, not the requested
	// one); apedec.c then decodes as many samples as that partial bitstream allows. Match that:
	// decode frames[this.idx] with whatever's buffered, clamped to what's actually available.
	flush() {
		if (this.freed) return EMPTY
		if (!this.header) { if (this.accumLen) throw Error("Truncated Monkey's Audio header"); return EMPTY }
		let frames = this.header.frames, last = frames.length - 1
		if (this.idx > last) return EMPTY
		let fr = frames[this.idx], bufOff = fr.pos - this.fileOff
		let avail = this.left ? this.left.length - bufOff : 0
		let size
		if (this.idx === last) {
			let rawPos = fr.pos + fr.skip
			size = this.totalBytes - this.header.wavtaillength - rawPos
			size -= size & 3
			if (size <= 0) size = fr.nblocks * 8
			size = (size + fr.skip + 3) & ~3
		} else size = fr.size // known and already rounded at parse time; just short of arriving in full
		size = Math.max(0, Math.min(size, avail))
		let parts = []
		if (bufOff >= 0 && size > 0) this.decodeFrame({ ...fr, size }, bufOff, parts)
		this.idx = frames.length
		this.left = null
		return this.result(parts)
	}

	free() {
		if (this.freed) return
		this.freed = true
		if (this.h) { this.m._audio_ape_destroy(this.h); this.h = 0 }
		if (this.ptr) { this.m._free(this.ptr); this.ptr = 0; this.cap = 0 }
		this.left = null
	}

	alloc(len) {
		if (len > this.cap) {
			if (this.ptr) this.m._free(this.ptr)
			this.cap = len
			this.ptr = this.m._malloc(len)
			if (!this.ptr) throw Error('APE: out of WASM memory')
		}
		return this.ptr
	}
}

// Replicates libavformat/ape.c ape_read_header(): descriptor block (fileversion >= 3980) or the
// legacy fixed header (3800–3979), then the seek table. Returns null if `buf` doesn't yet hold the
// whole header + seek table (caller waits for more bytes), throws on structurally invalid headers.
function parseHeader(buf) {
	if (buf.length < 6) return null
	let dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
	let version = dv.getUint16(4, true)
	if (version < MIN_VERSION || version > MAX_VERSION)
		throw Error("Unsupported Monkey's Audio version " + (version / 1000).toFixed(2))

	let descriptorlength, headerlength, seektablelength, wavheaderlength, wavtaillength
	let compressiontype, formatflags, blocksperframe, finalframeblocks, totalframes, bps, channels, sampleRate
	let seekPos                // physical buffer offset where the seek table starts
	let extraFirstframe = 0    // version < 3810: trailing 1-byte-per-frame bittable folds into firstframe

	if (version >= 3980) {
		if (buf.length < 52) return null
		descriptorlength = dv.getUint32(8, true)
		headerlength = dv.getUint32(12, true)
		seektablelength = dv.getUint32(16, true)
		wavheaderlength = dv.getUint32(20, true)
		wavtaillength = dv.getUint32(32, true)
		let descEnd = Math.max(52, descriptorlength) // "skip any unknown bytes at the end of the descriptor"
		if (buf.length < descEnd + 24) return null
		compressiontype = dv.getUint16(descEnd + 0, true)
		formatflags = dv.getUint16(descEnd + 2, true)
		blocksperframe = dv.getUint32(descEnd + 4, true)
		finalframeblocks = dv.getUint32(descEnd + 8, true)
		totalframes = dv.getUint32(descEnd + 12, true)
		bps = dv.getUint16(descEnd + 16, true)
		channels = dv.getUint16(descEnd + 18, true)
		sampleRate = dv.getUint32(descEnd + 20, true)
		seekPos = descEnd + 24 // ape.c reads the seek table right after the 8 fixed fields, not after `headerlength`
	} else {
		descriptorlength = 0
		compressiontype = dv.getUint16(6, true)
		formatflags = dv.getUint16(8, true)
		channels = dv.getUint16(10, true)
		sampleRate = dv.getUint32(12, true)
		wavheaderlength = dv.getUint32(16, true)
		wavtaillength = dv.getUint32(20, true)
		totalframes = dv.getUint32(24, true)
		finalframeblocks = dv.getUint32(28, true)
		headerlength = 32
		let off = 32
		if (formatflags & FLAG_HAS_PEAK) { off += 4; headerlength += 4 }
		if (formatflags & FLAG_HAS_SEEK) {
			if (buf.length < off + 4) return null
			seektablelength = dv.getUint32(off, true) * 4
			off += 4; headerlength += 4
		} else seektablelength = totalframes * 4
		bps = (formatflags & FLAG_8BIT) ? 8 : (formatflags & FLAG_24BIT) ? 24 : 16
		blocksperframe = version >= 3950 ? 73728 * 4 : (version >= 3900 || compressiontype >= 4000) ? 73728 : 9216
		if (!(formatflags & FLAG_WAV_HEADER)) off += wavheaderlength // embedded WAV header sits before the seek table in the legacy layout
		seekPos = off
		if (version < 3810) extraFirstframe = totalframes
	}

	if (!totalframes) throw Error("Monkey's Audio file has no frames")
	if (seektablelength / 4 < totalframes) throw Error("Monkey's Audio seek table is smaller than the frame count")
	if (channels < 1 || channels > 2) throw Error("Monkey's Audio: only mono and stereo are supported (ffmpeg apedec.c)")
	if (bps !== 8 && bps !== 16 && bps !== 24) throw Error("Monkey's Audio: unsupported bit depth " + bps)

	let bitTableBytes = version < 3810 ? totalframes : 0
	if (buf.length < seekPos + totalframes * 4 + bitTableBytes) return null

	let firstframe = descriptorlength + headerlength + seektablelength + wavheaderlength + extraFirstframe
	let frames = new Array(totalframes)
	frames[0] = { pos: firstframe, nblocks: blocksperframe, skip: 0, size: 0 }
	for (let i = 1; i < totalframes; i++) {
		let pos = dv.getUint32(seekPos + i * 4, true)
		frames[i] = { pos, nblocks: blocksperframe, skip: (pos - firstframe) & 3, size: 0 }
		frames[i - 1].size = frames[i].pos - frames[i - 1].pos
	}
	frames[totalframes - 1].nblocks = finalframeblocks
	frames[totalframes - 1].size = -1 // resolved in flush() from the stream's total length

	for (let fr of frames) {
		if (fr.skip) { fr.pos -= fr.skip; if (fr.size >= 0) fr.size += fr.skip }
		if (fr.size >= 0) fr.size = (fr.size + 3) & ~3
	}

	if (version < 3810) {
		let bitStart = seekPos + totalframes * 4
		for (let i = 0; i < totalframes; i++) {
			let bits = buf[bitStart + i]
			if (i && bits) frames[i - 1].size += 4
			frames[i].skip = (frames[i].skip << 3) + bits
		}
	}

	let extradata = new Uint8Array(6), edv = new DataView(extradata.buffer)
	edv.setUint16(0, version, true); edv.setUint16(2, compressiontype, true); edv.setUint16(4, formatflags, true)

	return { channels, sampleRate, bps, extradata, frames, wavtaillength }
}

function append(left, buf) {
	if (!left?.length) return buf.slice()
	let out = new Uint8Array(left.length + buf.length)
	out.set(left); out.set(buf, left.length)
	return out
}

function concat(parts, total) {
	if (parts.length === 1) return parts[0]
	let out = new Uint8Array(total), off = 0
	for (let p of parts) { out.set(p, off); off += p.length }
	return out
}

function merge(a, b) {
	if (!b?.channelData?.length) return a
	if (!a?.channelData?.length) return b
	return { channelData: a.channelData.map((ch, i) => { let m = new Float32Array(ch.length + b.channelData[i].length); m.set(ch); m.set(b.channelData[i], ch.length); return m }), sampleRate: a.sampleRate }
}
