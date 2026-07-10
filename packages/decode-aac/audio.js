// audio.js manifest — codec atom, decode half: whole-buffer bytes → { channelData,
// sampleRate }. Hosts merge with the encode half (@audio/encode-aac) by format
// name. Format detection is magic-byte (audio-type) — no test() needed here.

import decodeFn from './decode-aac.js'

export const aac = {
	codec: 'aac',
	decode: (bytes) => decodeFn(bytes),
}
