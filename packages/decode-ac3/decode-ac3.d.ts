export interface AudioData {
  channelData: Float32Array[];
  sampleRate: number;
}

interface AC3Decoder {
  /** Decode a chunk of a raw AC-3 frame stream synchronously. Partial frames carry over to the next call. */
  decode(data: Uint8Array | ArrayBuffer): AudioData;
  /** Drop any partial frame. */
  flush(): AudioData;
  free(): void;
  /** Frames that failed to decode so far */
  errors: number;
}

/** Decode a complete raw AC-3 stream. Channels come out in WAV order: FL, FR, FC, LFE, BL, BR (as present). */
export default function decode(src: ArrayBuffer | Uint8Array): Promise<AudioData>;

/** Initialize WASM and create a decoder with synchronous methods. */
export function decoder(): Promise<AC3Decoder>;
