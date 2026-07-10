// audio.js manifest — codec atom, decode half: whole-buffer bytes → { channelData,
// sampleRate }. Hosts merge with the encode half (@audio/encode-webm) by format
// name. Format detection is magic-byte (audio-type) — no test() needed here.

import decodeFn from './decode-webm.js'

export const webm = {
	codec: 'webm',
	decode: (bytes) => decodeFn(bytes),
}
