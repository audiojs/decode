export interface AudioData {
  channelData: Float32Array[];
  sampleRate: number;
}

export interface DecodeOpts {
  /** @default 48000 */
  sampleRate?: number;
  /** mono / stereo / quad (L,R,RL,RR). @default 2 */
  channels?: 1 | 2 | 4;
  /** Seconds to render. @default libopenmpt's own duration estimate, capped at 600s */
  duration?: number;
  /** OPENMPT_MODULE_RENDER_INTERPOLATIONFILTER_LENGTH: 0 internal default, 1 zero-order hold, 2 linear, 4 cubic, 8 windowed sinc (8 taps). @default 8 */
  interpolation?: 0 | 1 | 2 | 4 | 8;
  /** Percent, [0,200]. @default 100 */
  stereoSeparation?: number;
  /** Master gain in dB. */
  gain?: number;
}

export interface ModuleInfo {
  title: string;
  artist: string;
  /** Format extension, e.g. "it" */
  type: string;
  /** Format name, e.g. "Impulse Tracker" */
  typeLong: string;
  /** Tracker the file was (most likely) saved with */
  tracker: string;
  /** Song message, or instrument/sample name listing when the format has no message */
  message: string;
  /** libopenmpt's duration estimate in seconds (openmpt_module_get_duration_seconds) */
  duration: number;
  /** Pattern channel count — independent of the rendered output channel count */
  channels: number;
  patterns: number;
  orders: number;
  instruments: number;
  samples: number;
}

interface ModDecoder {
  /** Renders a complete module file. Partial buffers are not supported — a module isn't a stream. */
  decode(data: Uint8Array | ArrayBuffer): Promise<AudioData>;
  /** No-op: decode() already returns the full render. */
  flush(): AudioData;
  /** No-op: no WASM state outlives a single decode() call. */
  free(): void;
}

/** Decode a complete tracker module (MOD, XM, S3M, IT, MPTM, …) to PCM. */
export default function decode(src: ArrayBuffer | Uint8Array, opts?: DecodeOpts): Promise<AudioData>;

/** Read module metadata (title, duration, channel/pattern/order counts…) without rendering audio. */
export function info(src: ArrayBuffer | Uint8Array): Promise<ModuleInfo>;

/** Initialize WASM and create a whole-file decoder. */
export function decoder(opts?: DecodeOpts): Promise<ModDecoder>;
