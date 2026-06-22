/**
 * Audio decoder: whole-file, streaming, chunked
 * @module audio-decode
 *
 * let { channelData, sampleRate } = await decode(buf)
 *
 * for await (let pcm of decode.mp3(source)) { ... }
 *
 * let dec = await decode.mp3()
 * let { channelData, sampleRate } = await dec(chunk)
 * await dec() // close
 */

import getType from 'audio-type';

const EMPTY = Object.freeze({ channelData: Object.freeze([]), sampleRate: 0 })

/**
 * Decode audio.
 * 1 arg:  whole-file — auto-detects format, returns Promise<AudioData>
 * 2 args: chunked — streams from ReadableStream/AsyncIterable, returns AsyncGenerator<AudioData>
 */
export default function decode(src, format) {
	if (format) return decodeChunked(src, format)
	return decodeWhole(src)
}

async function decodeWhole(src) {
	// Blob / File / Response — anything that materializes to an ArrayBuffer
	if (src && typeof src.arrayBuffer === 'function') src = await src.arrayBuffer()
	if (!src || typeof src === 'string' || !(src.buffer || src.byteLength || src.length))
		throw TypeError('Expected ArrayBuffer, Uint8Array, Buffer, Blob, File, or Response')
	let buf = new Uint8Array(src)

	let type = getType(buf)
	if (!type) throw Error('Unknown audio format')
	if (!decode[type]) throw Error('No decoder for ' + type)

	let dec = await decode[type]()
	try {
		let result = await dec(buf)
		let flushed = await dec()
		return merge(result, flushed)
	} catch (e) { dec.free(); throw e }
}

/**
 * Decode a ReadableStream or async iterable of encoded audio chunks.
 * @param {ReadableStream|AsyncIterable} source
 * @param {string} format - codec name
 * @returns {AsyncGenerator<{channelData: Float32Array[], sampleRate: number}>}
 */
export async function* decodeChunked(source, format) {
	if (!decode[format]) throw Error('No decoder for ' + format)
	let dec = await decode[format]()
	try {
		if (source.getReader) {
			let reader = source.getReader()
			while (true) {
				let { done, value } = await reader.read()
				if (done) break
				let result = await dec(value instanceof Uint8Array ? value : new Uint8Array(value))
				if (result.channelData.length) yield result
			}
		} else {
			for await (let chunk of source) {
				let result = await dec(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))
				if (result.channelData.length) yield result
			}
		}
		let flushed = await dec()
		if (flushed.channelData.length) yield flushed
	} finally {
		dec.free()
	}
}

// --- format registration ---

function reg(name, load) {
	decode[name] = fmt(name, async () => {
		let mod = await load()
		// @audio/* packages export { decoder, default }
		if (mod.decoder) {
			let codec = await mod.decoder()
			return streamDecoder(
				chunk => codec.decode(chunk),
				codec.flush ? () => codec.flush() : null,
				codec.free ? () => codec.free() : null
			)
		}
		// wasm-audio-decoders export class with .ready
		let init = mod.default || mod
		let codec = typeof init === 'function' ? await init() : init
		if (codec.ready) await codec.ready
		return streamDecoder(
			chunk => codec.decode(chunk),
			codec.flush ? () => codec.flush() : null,
			codec.free ? () => codec.free() : null
		)
	})
}

function fmt(name, init) {
	let fn = (src) => {
		if (!src) return init()
		// async iterable / ReadableStream → streaming decode
		if (src[Symbol.asyncIterator] || src.getReader) return decodeChunked(src, name)
		// buffer → whole-file decode
		console.warn('decode.' + name + '(data) is deprecated, use decode(data)')
		return (async () => {
			let dec = await init()
			try {
				let result = await dec(src instanceof Uint8Array ? src : new Uint8Array(src.buffer || src))
				let flushed = await dec()
				return merge(result, flushed)
			} catch (e) { dec.free(); throw e }
		})()
	}
	return fn
}

// --- codecs ---

reg('mp3', () => import('@audio/decode-mp3'))
reg('flac', () => import('@audio/decode-flac'))
reg('opus', () => import('@audio/decode-opus'))
reg('oga', () => import('@audio/decode-vorbis'))

reg('m4a', () => import('@audio/decode-aac'))

reg('wav', () => import('@audio/decode-wav'))
reg('qoa', () => import('@audio/decode-qoa'))

reg('aac', () => import('@audio/decode-aac'))
reg('aiff', () => import('@audio/decode-aiff'))
reg('caf', () => import('@audio/decode-caf'))
reg('webm', () => import('@audio/decode-webm'))
reg('amr', () => import('@audio/decode-amr'))
reg('wma', () => import('@audio/decode-wma'))

/**
 * StreamDecoder — a callable function:
 * dec(chunk)  — decode data, returns { channelData, sampleRate }
 * dec()       — end of stream: flush remaining samples + free resources
 * dec.flush() — flush without freeing
 * dec.free()  — release resources without flushing
 */
function streamDecoder(onDecode, onFlush, onFree) {
	let done = false
	let fn = async (chunk) => {
		if (chunk) {
			if (done) throw Error('Decoder already freed')
			try { return norm(await onDecode(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))) }
			catch (e) { done = true; onFree?.(); throw e }
		}
		// null/undefined = end of stream
		if (done) return EMPTY
		done = true
		try {
			let result = onFlush ? norm(await onFlush()) : EMPTY
			onFree?.()
			return result
		} catch (e) { onFree?.(); throw e }
	}
	fn.flush = async () => {
		if (done) return EMPTY
		return onFlush ? norm(await onFlush()) : EMPTY
	}
	fn.free = () => {
		if (done) return
		done = true
		onFree?.()
	}
	return fn
}

// extract { channelData, sampleRate } from codec result
function norm(r) {
	if (!r?.channelData?.length) return EMPTY
	let { channelData, sampleRate, samplesDecoded } = r
	if (samplesDecoded != null && samplesDecoded < channelData[0].length)
		channelData = channelData.map(ch => ch.subarray(0, samplesDecoded))
	if (!channelData[0]?.length) return EMPTY
	// collapse duplicate stereo to mono (some decoders always output 2ch for mono sources)
	if (channelData.length === 2) {
		let a = channelData[0], b = channelData[1], same = true
		for (let i = 0; i < a.length; i += 37) { if (a[i] !== b[i]) { same = false; break } }
		if (same) channelData = [a]
	}
	return { channelData, sampleRate }
}

// merge two decode results
function merge(a, b) {
	if (!b?.channelData?.length) return a
	if (!a?.channelData?.length) return b
	let ach = a.channelData.length, bch = b.channelData.length
	let ch = Math.max(ach, bch)
	return {
		channelData: Array.from({ length: ch }, (_, i) => {
			let ac = a.channelData[i % ach], bc = b.channelData[i % bch]
			let merged = new Float32Array(ac.length + bc.length)
			merged.set(ac)
			merged.set(bc, ac.length)
			return merged
		}),
		sampleRate: a.sampleRate
	}
}
