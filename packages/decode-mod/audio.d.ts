// Generated from the audio.js manifest (params metadata is the source of truth).
// Regenerate: node tools/dts.js in @audio/compile. Do not edit by hand.

/** Automatable number — scalar, `t => value` fn, or breakpoint curve {t, v} */
type Auto = number | ((t: number) => number) | { t: number[], v: number[] }
/** Per-block param values as delivered by hosts (numbers arrive as 1-length Float32Array) */
type Live = Record<string, Float32Array | string | boolean>
type Ctx = { sampleRate: number, maxBlockSize: number, maxChannels: number, currentTime: number, duration?: number, events?: readonly any[], emit?: (name: string, ...args: any[]) => void, [k: string]: unknown }
type Process = (inputs: Float32Array[][], outputs: Float32Array[][], params: Live) => void

type AudioData = { channelData: Float32Array[], sampleRate: number }

/** Codec plugin 'mod' — extends audio()'s openable formats / save() targets */
export declare const mod: { codec: 'mod', decode(bytes: Uint8Array): AudioData | Promise<AudioData> }
/** Codec plugin 'xm' — extends audio()'s openable formats / save() targets */
export declare const xm: { codec: 'xm', decode(bytes: Uint8Array): AudioData | Promise<AudioData> }
/** Codec plugin 's3m' — extends audio()'s openable formats / save() targets */
export declare const s3m: { codec: 's3m', decode(bytes: Uint8Array): AudioData | Promise<AudioData> }
/** Codec plugin 'it' — extends audio()'s openable formats / save() targets */
export declare const it: { codec: 'it', decode(bytes: Uint8Array): AudioData | Promise<AudioData> }
