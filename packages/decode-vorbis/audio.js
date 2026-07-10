// audio.js manifest — codec atom, decode half: whole-buffer bytes → { channelData,
// sampleRate }. Hosts merge with the encode half (@audio/encode-vorbis) by format
// name. Format detection is magic-byte (audio-type) — no test() needed here.

import decodeFn from './decode-vorbis.js'

export const vorbis = {
	codec: 'vorbis',
	decode: (bytes) => decodeFn(bytes),
}
