// audio.js manifest — codec atom, decode half: whole-buffer bytes → { channelData,
// sampleRate }. Hosts merge with the encode half (@audio/encode-opus) by format
// name. Format detection is magic-byte (audio-type) — no test() needed here.

import decodeFn from './decode-opus.js'

export const opus = {
	codec: 'opus',
	decode: (bytes) => decodeFn(bytes),
}
