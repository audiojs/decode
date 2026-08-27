export interface AudioData {
  channelData: Float32Array[];
  sampleRate: number;
}

interface AACDecoder {
  /** Byte stream (M4A/ADTS), or with `asc`/`alac` options: one raw access unit or an array of them */
  decode(data: Uint8Array | ArrayBuffer | Uint8Array[]): AudioData;
  flush(): AudioData;
  free(): void;
}

/** Whole-file decode — auto-detects M4A vs ADTS */
export default function decode(src: ArrayBuffer | Uint8Array): Promise<AudioData>;

export interface RawOptions {
  /** AudioSpecificConfig — decode raw AAC access units from a container demuxer */
  asc?: Uint8Array;
  /** ALAC magic cookie (24-byte ALACSpecificConfig, `alac` box body, or full atom) — decode raw ALAC frames */
  alac?: Uint8Array;
}

/** Create streaming decoder instance. Auto-detects M4A vs ADTS, or decodes raw frames when a config is given. */
export function decoder(opts?: RawOptions): Promise<AACDecoder>;
