/** Decoded PCM: planar channel data + rate. */
export interface Decoded { channelData: Float32Array[], sampleRate: number }
/** Decode a complete WAV file (PCM int 8/16/24/32, float32/64, A-law/µ-law). */
export default function decode(src: Uint8Array | ArrayBuffer): Promise<Decoded>
/** Streaming decoder half per the @audio codec convention. */
export function decoder(): Promise<{ decode(chunk: Uint8Array): Decoded | null, flush(): Decoded | null }>
