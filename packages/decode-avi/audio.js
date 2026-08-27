// audio.js manifest — codec atom, decode half: whole-buffer bytes → { channelData,
// sampleRate }. Format detection is magic-byte (audio-type) — no test() needed here.

import decodeFn from './decode-avi.js'

export const avi = {
	codec: 'avi',
	decode: (bytes) => decodeFn(bytes),
}
