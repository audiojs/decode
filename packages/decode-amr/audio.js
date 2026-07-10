// audio.js manifest — codec atom, decode half: whole-buffer bytes → { channelData,
// sampleRate }. Hosts merge with the encode half (@audio/encode-amr) by format
// name. Format detection is magic-byte (audio-type) — no test() needed here.

import decodeFn from './decode-amr.js'

export const amr = {
	codec: 'amr',
	decode: (bytes) => decodeFn(bytes),
}
