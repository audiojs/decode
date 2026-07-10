// audio.js manifest — codec atom, decode half: whole-buffer bytes → { channelData,
// sampleRate }. Hosts merge with the encode half (@audio/encode-wav) by format
// name. Format detection is magic-byte (audio-type) — no test() needed here.

import decodeFn from './decode-wav.js'

export const wav = {
	codec: 'wav',
	decode: (bytes) => decodeFn(bytes),
}
