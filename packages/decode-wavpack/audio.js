// audio.js manifest — codec atom, decode half: whole-buffer bytes → { channelData,
// sampleRate }. Format detection is magic-byte (audio-type, 'wvpk' at offset 0) — no test() needed here.

import decodeFn from './decode-wavpack.js'

export const wv = {
	codec: 'wv',
	decode: (bytes) => decodeFn(bytes),
}
