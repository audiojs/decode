// audio.js manifest — codec atoms, decode half: whole-buffer bytes → { channelData,
// sampleRate }. One libopenmpt decoder serves four format names (MPTM shares the IT
// loader). Format detection is magic-byte (audio-type) — no test() needed here.

import decodeFn from './decode-mod.js'

const decode = (bytes) => decodeFn(bytes)

export const mod = { codec: 'mod', decode }
export const xm = { codec: 'xm', decode }
export const s3m = { codec: 's3m', decode }
export const it = { codec: 'it', decode }
