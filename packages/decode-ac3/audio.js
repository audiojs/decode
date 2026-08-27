// audio.js manifest — codec atom, decode half: whole-buffer bytes → { channelData,
// sampleRate }. Format detection is magic-byte (audio-type) — no test() needed here.

import decodeFn from './decode-ac3.js'

export const ac3 = {
	codec: 'ac3',
	decode: (bytes) => decodeFn(bytes),
}
