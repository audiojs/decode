export interface AudioData {
  channelData: Float32Array[];
  sampleRate: number;
}

export interface DSDDecoderOptions {
  /** Output sample rate in Hz. Must equal dsdRate/8, /16, /32 or /64. Default: dsdRate/32. */
  sampleRate?: number;
  /** Passband edge as a fraction of the output rate. Default 0.45. */
  cutoff?: number;
  /** Total FIR taps of the rate-determining filter (stage 2, or stage 1 when ratio===8). */
  length?: number;
  /** Target stopband attenuation in dB, used to derive the Kaiser β. Default 100. */
  stopband?: number;
}

interface DSDDecoder {
  /** Decode a chunk of raw DSF or DFF bytes synchronously. Partial blocks carry over. */
  decode(data: Uint8Array | ArrayBuffer): AudioData;
  /** Zero-pad and decode the final partial block; drops nothing already emitted. */
  flush(): AudioData;
  free(): void;
}

/** Decode a complete DSF or DFF file synchronously. */
export default function decode(src: ArrayBuffer | Uint8Array, opts?: DSDDecoderOptions): AudioData;

/** Create a synchronous streaming decoder. */
export function decoder(opts?: DSDDecoderOptions): DSDDecoder;
