// Direct decoder imports and decoding run inside AudioWorkletGlobalScope.
import aacDecode, { decoder as aacDecoder } from './packages/decode-aac/decode-aac.js'
import aiffDecode from './packages/decode-aiff/decode-aiff.js'
import amrDecode, { decoder as amrDecoder } from './packages/decode-amr/decode-amr.js'
import cafDecode from './packages/decode-caf/decode-caf.js'
import flacDecode, { decoder as flacDecoder } from './packages/decode-flac/decode-flac.js'
import mp3Decode, { decoder as mp3Decoder } from './packages/decode-mp3/decode-mp3.js'
import opusDecode, { decoder as opusDecoder } from './packages/decode-opus/decode-opus.js'
import qoaDecode from './packages/decode-qoa/decode-qoa.js'
import vorbisDecode, { decoder as vorbisDecoder } from './packages/decode-vorbis/decode-vorbis.js'
import wavDecode from './packages/decode-wav/decode-wav.js'
import webmDecode, { decoder as webmDecoder } from './packages/decode-webm/decode-webm.js'
import wmaDecode, { decoder as wmaDecoder } from './packages/decode-wma/decode-wma.js'

const summarize = value => {
	if (typeof value?.then === 'function') return { sync: false }
	let channelData = value.channelData || []
	return {
		sync: true,
		channels: channelData.length,
		samples: channelData[0]?.length || 0,
		sampleRate: value.sampleRate,
		finite: channelData.every(channel => channel.every(Number.isFinite)),
		active: channelData.some(channel => channel.some(sample => sample !== 0)),
	}
}

const runWhole = async (decode, bytes) => {
	let output = decode(new Uint8Array(bytes))
	let promised = typeof output?.then === 'function'
	return { promised, ...summarize(await output) }
}

const runDecoder = async (create, inputs, flush = false) => {
	let decoder = await create()
	try {
		let output = [
			decoder.decode(null),
			decoder.decode(new Uint8Array()),
			...inputs.map(bytes => decoder.decode(new Uint8Array(bytes))),
		]
		if (flush) output.push(decoder.flush())
		return output.map(summarize)
	} finally {
		decoder.free()
	}
}

const runSplitDecoder = async (create, bytes, split) => {
	let decoder = await create()
	try {
		return [
			summarize(decoder.decode(new Uint8Array(bytes.slice(0, split)))),
			summarize(decoder.decode(new Uint8Array(bytes.slice(split)))),
			summarize(decoder.flush()),
		]
	} finally {
		decoder.free()
	}
}

registerProcessor('decode-test', class extends AudioWorkletProcessor {
	constructor({ processorOptions: fixtures }) {
		super()
		this.decodeAll(fixtures)
	}
	async decodeAll(fixtures) {
		let globals = ['Blob', 'TextDecoder', 'atob', 'Worker', 'URL', 'fetch', 'performance', 'setTimeout']
		let report = { globals: Object.fromEntries(globals.map(name => [name, typeof globalThis[name]])) }
		try {
			report.flac = await runDecoder(flacDecoder, [fixtures.flacA, fixtures.flacA, fixtures.flacB])
			report.vorbis = await runDecoder(vorbisDecoder, [fixtures.vorbisA, fixtures.vorbisA, fixtures.vorbisB])
			report.mp3 = await runDecoder(mp3Decoder, [fixtures.mp3])
			report.opus = await runDecoder(opusDecoder, [fixtures.opus], true)
			report.webmOpus = await runDecoder(webmDecoder, [fixtures.webmOpus], true)
			report.webmVorbis = await runDecoder(webmDecoder, [fixtures.webmVorbis], true)
			report.aac = await runDecoder(aacDecoder, [fixtures.aac], true)
			report.m4a = await runDecoder(aacDecoder, [fixtures.m4a], true)
			report.alac = await runDecoder(aacDecoder, [fixtures.alac], true)
			report.amrNb = await runDecoder(amrDecoder, [fixtures.amrNb], true)
			report.amrWb = await runDecoder(amrDecoder, [fixtures.amrWb], true)
			report.wmaMono = await runDecoder(wmaDecoder, [fixtures.wmaMono], true)
			report.wmaStereo = await runDecoder(wmaDecoder, [fixtures.wmaStereo], true)
			report.splits = {
				opus: await runSplitDecoder(opusDecoder, fixtures.opus, fixtures.opus.byteLength - 1),
				aac: await runSplitDecoder(aacDecoder, fixtures.aac, fixtures.aac.byteLength - 1),
				amrNb: await runSplitDecoder(amrDecoder, fixtures.amrNb, fixtures.amrNb.byteLength - 1),
				wmaMono: await runSplitDecoder(wmaDecoder, fixtures.wmaMono, fixtures.wmaMono.byteLength - 1),
			}
			report.whole = {
				flac: await runWhole(flacDecode, fixtures.flacB),
				vorbis: await runWhole(vorbisDecode, fixtures.vorbisB),
				mp3: await runWhole(mp3Decode, fixtures.mp3),
				opus: await runWhole(opusDecode, fixtures.opus),
				webmOpus: await runWhole(webmDecode, fixtures.webmOpus),
				webmVorbis: await runWhole(webmDecode, fixtures.webmVorbis),
				aac: await runWhole(aacDecode, fixtures.aac),
				m4a: await runWhole(aacDecode, fixtures.m4a),
				alac: await runWhole(aacDecode, fixtures.alac),
				amrNb: await runWhole(amrDecode, fixtures.amrNb),
				amrWb: await runWhole(amrDecode, fixtures.amrWb),
				wmaMono: await runWhole(wmaDecode, fixtures.wmaMono),
				wmaStereo: await runWhole(wmaDecode, fixtures.wmaStereo),
			}
			report.wav = summarize(wavDecode(new Uint8Array(fixtures.wav)))
			report.aiff = summarize(aiffDecode(new Uint8Array(fixtures.aiff)))
			report.caf = summarize(cafDecode(new Uint8Array(fixtures.caf)))
			report.qoa = summarize(qoaDecode(new Uint8Array(fixtures.qoa)))
		} catch (error) {
			report.error = String(error?.stack || error)
		}
		this.port.postMessage(report)
	}
	process() { return true }
})
