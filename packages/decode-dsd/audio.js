// audio.js manifest — codec atoms, decode half: whole-buffer bytes → { channelData,
// sampleRate }. One decoder serves both DSD containers. Format detection is magic-byte
// (audio-type) — no test() needed here.

import decodeFn from './decode-dsd.js'

export const dsf = {
	codec: 'dsf',
	decode: (bytes) => decodeFn(bytes),
}

export const dff = {
	codec: 'dff',
	decode: (bytes) => decodeFn(bytes),
}
