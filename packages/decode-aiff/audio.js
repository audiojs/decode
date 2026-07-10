// audio.js manifest — codec atom, decode half: whole-buffer bytes → { channelData,
// sampleRate }. Hosts merge with the encode half (@audio/encode-aiff) by format
// name. Format detection is magic-byte (audio-type) — no test() needed here.

import decodeFn from './decode-aiff.js'

export const aiff = {
	codec: 'aiff',
	decode: (bytes) => decodeFn(bytes),
}
