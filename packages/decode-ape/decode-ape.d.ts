export interface AudioData {
  channelData: Float32Array[];
  sampleRate: number;
}

interface APEDecoder {
  /** Decode a chunk of a raw Monkey's Audio (.ape) stream synchronously. Frame boundaries come
   * from the file header, so decode() may return EMPTY until the header + seek table are complete. */
  decode(data: Uint8Array | ArrayBuffer): AudioData;
  /** Decode the final frame, whose length depends on the stream's total size. */
  flush(): AudioData;
  free(): void;
  /** Frames that failed to decode so far */
  errors: number;
}

/** Decode a complete Monkey's Audio (.ape) file. Mono or stereo, 8/16/24-bit, any compression level. */
export default function decode(src: ArrayBuffer | Uint8Array): Promise<AudioData>;

/** Initialize WASM and create a decoder with synchronous methods. */
export function decoder(): Promise<APEDecoder>;
