// audio.js manifest — codec atom, decode half: whole-buffer bytes → { channelData,
// sampleRate }. Hosts merge with the encode half (@audio/encode-caf) by format
// name. Format detection is magic-byte (audio-type) — no test() needed here.

import decodeFn from './decode-caf.js'

export const caf = {
	codec: 'caf',
	decode: (bytes) => decodeFn(bytes),
}
