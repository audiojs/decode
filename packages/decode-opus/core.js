import createOpus from './src/opus.wasm.js'

const ERRORS = new Map([
	[-1, 'OPUS_BAD_ARG'],
	[-2, 'OPUS_BUFFER_TOO_SMALL'],
	[-3, 'OPUS_INTERNAL_ERROR'],
	[-4, 'OPUS_INVALID_PACKET'],
	[-5, 'OPUS_UNIMPLEMENTED'],
	[-6, 'OPUS_INVALID_STATE'],
	[-7, 'OPUS_ALLOC_FAIL']
])

let modulePromise

async function getModule() {
	if (modulePromise) return modulePromise
	let promise = createOpus()
	modulePromise = promise
	try { return await promise }
	catch (error) { modulePromise = null; throw error }
}

export async function createOpusDecoder() {
	return new OpusDecoder(await getModule())
}

class OpusDecoder {
	constructor(module) {
		this.module = module
		this.handle = 0
		this.input = 0
		this.capacity = 0
		this.channels = 0
		this.sampleRate = 0
		this.frameNumber = 0
		this.inputBytes = 0
		this.outputSamples = 0
		this.freed = false
	}

	configure(options) {
		if (this.freed) throw Error('Decoder already freed')
		let sampleRate = options.sampleRate ?? 48000
		let channels = options.channels
		if (![8000, 12000, 16000, 24000, 48000].includes(sampleRate)) throw RangeError('Invalid Opus sample rate')
		if (!Number.isInteger(channels) || channels < 1 || channels > 255) throw RangeError('Invalid Opus channel count')

		let streams = options.streamCount ?? 1
		let coupled = options.coupledStreamCount ?? (channels === 2 ? 1 : 0)
		if (!Number.isInteger(streams) || streams < 1 || streams > 255 ||
			!Number.isInteger(coupled) || coupled < 0 || coupled > streams || streams + coupled > 255)
			throw RangeError('Invalid Opus stream layout')

		let mapping = options.channelMappingTable ?? (channels === 1 ? [0] : channels === 2 ? [0, 1] : null)
		if (!mapping || mapping.length !== channels) throw Error('Invalid Opus channel mapping')
		mapping = Array.from(mapping)
		let codedChannels = streams + coupled
		if (mapping.some(value => !Number.isInteger(value) || value < 0 || value > 255 || (value >= codedChannels && value !== 255)))
			throw Error('Invalid Opus channel mapping')

		let preSkip = options.preSkip ?? 0
		let outputGain = options.outputGain ?? 0
		if (!Number.isSafeInteger(preSkip) || preSkip < 0 || preSkip > 0x7fffffff) throw RangeError('Invalid Opus pre-skip')
		if (!Number.isInteger(outputGain) || outputGain < -32768 || outputGain > 32767) throw RangeError('Invalid Opus output gain')

		this.unconfigure()
		let map = this.module._malloc(channels)
		if (!map) throw Error('Unable to allocate Opus channel mapping')
		try {
			this.module.HEAPU8.set(mapping, map)
			this.handle = this.module._audio_opus_create(sampleRate, channels, streams, coupled, map, preSkip, outputGain)
		} finally { this.module._free(map) }
		if (!this.handle) {
			let code = this.module._audio_opus_last_error()
			throw Error('libopus ' + code + ' ' + (ERRORS.get(code) || 'UNKNOWN_ERROR'))
		}

		this.channels = channels
		this.sampleRate = sampleRate
		this.frameNumber = 0
		this.inputBytes = 0
		this.outputSamples = 0
	}

	decodeFrames(frames) {
		if (this.freed) throw Error('Decoder already freed')
		if (!this.handle) throw Error('Opus decoder is not configured')
		let chunks = [], errors = [], samplesDecoded = 0

		for (let packet of frames) {
			if (!(packet instanceof Uint8Array)) throw TypeError('Opus packet must be a Uint8Array')
			if (packet.length > this.capacity) {
				let input = this.module._malloc(packet.length)
				if (!input) throw Error('Unable to allocate Opus input buffer')
				if (this.input) this.module._free(this.input)
				this.input = input
				this.capacity = packet.length
			}
			if (packet.length) this.module.HEAPU8.set(packet, this.input)

			let decoded = this.module._audio_opus_decode(this.handle, this.input, packet.length)
			if (decoded < 0) {
				errors.push({
					message: 'libopus ' + decoded + ' ' + (ERRORS.get(decoded) || 'UNKNOWN_ERROR'),
					frameLength: packet.length,
					frameNumber: this.frameNumber,
					inputBytes: this.inputBytes,
					outputSamples: this.outputSamples
				})
			} else if (decoded) {
				let offset = this.module._audio_opus_output(this.handle) >> 2
				chunks.push(Array.from({ length: this.channels }, (_, channel) =>
					this.module.HEAPF32.slice(offset + channel * decoded, offset + (channel + 1) * decoded)
				))
				samplesDecoded += decoded
				this.outputSamples += decoded
			}
			this.frameNumber++
			this.inputBytes += packet.length
		}

		let channelData = samplesDecoded ? Array.from({ length: this.channels }, (_, channel) => {
			let output = new Float32Array(samplesDecoded), offset = 0
			for (let chunk of chunks) { output.set(chunk[channel], offset); offset += chunk[channel].length }
			return output
		}) : []

		return { errors, channelData, samplesDecoded, sampleRate: this.sampleRate, bitDepth: 32 }
	}

	unconfigure() {
		if (!this.handle) return
		this.module._audio_opus_destroy(this.handle)
		this.handle = 0
		this.channels = 0
		this.sampleRate = 0
	}

	free() {
		if (this.freed) return
		this.unconfigure()
		if (this.input) this.module._free(this.input)
		this.input = 0
		this.capacity = 0
		this.freed = true
	}
}
