// audio.js manifest — codec atom, decode half: whole-buffer bytes → { channelData,
// sampleRate }. Hosts merge with the encode half (@audio/encode-mp3) by format
// name. Format detection is magic-byte (audio-type) — no test() needed here.

import decodeFn from './decode-mp3.js'

export const mp3 = {
	codec: 'mp3',
	decode: (bytes) => decodeFn(bytes),
}
