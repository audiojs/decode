export interface AudioData {
  channelData: Float32Array[];
  sampleRate: number;
}

interface WavpackDecoder {
  /** Decode a chunk of a WavPack (.wv) stream synchronously. Partial blocks carry over to the next call. */
  decode(data: Uint8Array | ArrayBuffer): AudioData;
  /** Drop any incomplete trailing block. decode() already returns every decodable sample, so this yields nothing new. */
  flush(): AudioData;
  free(): void;
}

/** Decode a complete WavPack stream. Channels come out in WAV order (as libwavpack reports them). */
export default function decode(src: ArrayBuffer | Uint8Array): Promise<AudioData>;

/** Initialize WASM and create a decoder with synchronous methods. */
export function decoder(): Promise<WavpackDecoder>;
