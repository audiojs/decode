// audio.js manifest — codec atom, decode half: whole-buffer bytes → { channelData,
// sampleRate }. Hosts merge with the encode half (@audio/encode-wma) by format
// name. Format detection is magic-byte (audio-type) — no test() needed here.

import decodeFn from './decode-wma.js'

export const wma = {
	codec: 'wma',
	decode: (bytes) => decodeFn(bytes),
}
