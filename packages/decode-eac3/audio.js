// audio.js manifest — codec atom, decode half: whole-buffer bytes → { channelData,
// sampleRate }. Format detection is magic-byte (audio-type) — no test() needed here.

import decodeFn from './decode-eac3.js'

export const eac3 = {
	codec: 'eac3',
	decode: (bytes) => decodeFn(bytes),
}
