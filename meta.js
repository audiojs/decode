/**
 * Meta parsers — re-export from codec packages.
 * @module audio-decode/meta
 *
 * import { wav, mp3, flac, oga, opus, m4a } from 'audio-decode/meta'
 * let result = wav(bytes)  // { meta, sampleRate, markers, regions } | null
 */

export { parseMeta as wav } from '@audio/decode-wav/meta'
export { parseMeta as mp3, parseId3v2 } from '@audio/decode-mp3/meta'
export { parseMeta as flac } from '@audio/decode-flac/meta'
export { parseMeta as oga } from '@audio/decode-vorbis/meta'
export { parseMeta as opus } from '@audio/decode-opus/meta'
export { parseMeta as m4a } from '@audio/decode-aac/meta'
