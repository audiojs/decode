// audio.js manifest — codec atom, decode half: whole-buffer bytes → { channelData,
// sampleRate }. Hosts merge with the encode half (@audio/encode-qoa) by format
// name. Format detection is magic-byte (audio-type) — no test() needed here.

import decodeFn from './decode-qoa.js'

export const qoa = {
	codec: 'qoa',
	decode: (bytes) => decodeFn(bytes),
}
