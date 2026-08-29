/**
 * ID3v2 metadata for DSD files.
 * DSF points to a trailing ID3v2 tag via the DSD chunk's metadata pointer. DFF has no standard
 * metadata chunk, but some tools (e.g. foobar2000) append a non-standard local 'ID3 ' chunk —
 * read it the same way if present.
 * @module @audio/decode-dsd/meta
 */

import { parseId3v2 } from '@audio/decode-mp3/meta'

function str4(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) }
function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 }
function u64le(b, o) { return u32le(b, o) + u32le(b, o + 4) * 0x100000000 }
function u32be(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0 }
function u64be(b, o) { return u32be(b, o) * 0x100000000 + u32be(b, o + 4) }

function dsfMeta(b) {
	if (b.length < 28) return null
	const pointer = u64le(b, 20)
	if (!pointer || pointer >= b.length) return null
	return parseId3v2(b.subarray(pointer))
}

function dffMeta(b) {
	let off = 16
	while (off + 12 <= b.length) {
		const id = str4(b, off), size = u64be(b, off + 4), bodyStart = off + 12
		if (id === 'ID3 ') return parseId3v2(b.subarray(bodyStart, bodyStart + size))
		off = bodyStart + size + (size & 1)
	}
	return null
}

/** Parse DSD (DSF/DFF) metadata. Returns {meta, markers, regions} or null. */
export function parseMeta(bytes) {
	if (!bytes?.length) return null
	const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
	const r = str4(b, 0) === 'FRM8' ? dffMeta(b) : str4(b, 0) === 'DSD ' ? dsfMeta(b) : null
	return r ? { meta: r.meta, markers: r.markers, regions: r.regions } : null
}
