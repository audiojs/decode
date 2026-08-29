export interface AudioData {
  channelData: Float32Array[];
  sampleRate: number;
}

interface MpcDecoder {
  /** Decode a chunk of an SV7 (`MP+`) or SV8 (`MPCK`) Musepack stream synchronously. Returns whatever full frames the data seen so far allows; call again as more bytes arrive. */
  decode(data: Uint8Array | ArrayBuffer): AudioData;
  /** Signal end of stream: decode any frames a safety margin was withholding. */
  flush(): AudioData;
  free(): void;
  /** Frames that failed to decode (bitstream desync — stops the decoder) */
  errors: number;
}

/** Decode a complete Musepack (SV7 or SV8) stream. Throws if the stream never parses as Musepack. */
export default function decode(src: ArrayBuffer | Uint8Array): Promise<AudioData>;

/** Initialize WASM and create a decoder with synchronous methods. */
export function decoder(): Promise<MpcDecoder>;
