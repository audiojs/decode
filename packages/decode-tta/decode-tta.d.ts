/** Decoded PCM: planar channel data + rate. */
export interface AudioData { channelData: Float32Array[], sampleRate: number }

interface TTADecoder {
	/** Decode a chunk synchronously. Header/seek-table/frame boundaries carry over across calls. */
	decode(data: Uint8Array | ArrayBuffer): AudioData
	/** Drop any trailing incomplete header/seek-table/frame bytes. */
	flush(): AudioData
	free(): void
	/** Frames dropped so far for a CRC32 mismatch. */
	readonly errors: number
}

/** Decode a complete TTA (True Audio) stream synchronously. */
export default function decode(src: Uint8Array | ArrayBuffer): AudioData
/** Create a synchronous streaming decoder. */
export function decoder(): TTADecoder
