export interface AudioData {
  channelData: Float32Array[];
  sampleRate: number;
}

interface AVIDecoder {
  /**
   * Decode an AVI chunk. Synchronous once the stream headers have been seen; the call that
   * completes them returns a Promise while the codec module loads.
   */
  decode(data: Uint8Array | ArrayBuffer): AudioData | Promise<AudioData>;
  /** Finish the stream. Throws if no audio stream was found. */
  flush(): AudioData | Promise<AudioData>;
  free(): void;
}

/** Decode the audio stream of a complete AVI file. */
export default function decode(src: ArrayBuffer | Uint8Array): Promise<AudioData>;

/** Create a streaming decoder. */
export function decoder(): Promise<AVIDecoder>;
