export interface AudioData {
  channelData: Float32Array[];
  sampleRate: number;
}

interface MP4Decoder {
  /**
   * Decode an MP4 chunk. Synchronous once the track header (moov) has been seen; the call that
   * completes the header returns a Promise while the codec module loads.
   */
  decode(data: Uint8Array | ArrayBuffer): AudioData | Promise<AudioData>;
  /** Finish the stream. Throws if no audio track was found. */
  flush(): AudioData | Promise<AudioData>;
  free(): void;
}

/** Decode the audio track of a complete MP4 / MOV / M4A / M4V / 3GP file. */
export default function decode(src: ArrayBuffer | Uint8Array): Promise<AudioData>;

/** Create a streaming decoder. */
export function decoder(): Promise<MP4Decoder>;
