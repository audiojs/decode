// audio.js manifest — codec atom, decode half: whole-buffer bytes → { channelData,
// sampleRate }. Hosts merge with the encode half (@audio/encode-flac) by format
// name. Format detection is magic-byte (audio-type) — no test() needed here.

import decodeFn from './decode-flac.js'

export const flac = {
	codec: 'flac',
	decode: (bytes) => decodeFn(bytes),
}
