# @audio/decode-opus

Decode Ogg Opus audio to PCM samples. Self-contained WASM bundle — no import map entries needed.

Wraps [ogg-opus-decoder](https://github.com/eshaz/wasm-audio-decoders/tree/main/src/ogg-opus-decoder).

```js
import decode, { decoder } from '@audio/decode-opus'

// whole-file
let { channelData, sampleRate } = await decode(opusbuf)

// streaming
let dec = await decoder()
let a = dec.decode(chunk1)
let b = dec.decode(chunk2)
let c = dec.flush()
dec.free()
```

## Metadata

Read OpusTags (Vorbis comment) metadata and cover art without decoding audio:

```js
import { parseMeta } from '@audio/decode-opus/meta'

let { meta, sampleRate } = parseMeta(opusBytes)
// meta: { title, artist, album, year, genre, ..., pictures }
```

## License

[MIT](./LICENSE) · [ॐ](https://github.com/krishnized/license/)
