// audio.js manifest — codec atom, decode half: whole-buffer bytes → { channelData,
// sampleRate }. Format detection is magic-byte (audio-type) — no test() needed here.

import decodeFn from './decode-mp4.js'

export const mp4 = {
	codec: 'mp4',
	decode: (bytes) => decodeFn(bytes),
}
