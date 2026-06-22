# @audio/decode-vorbis

Decode Ogg Vorbis audio to PCM samples. Self-contained WASM bundle — no import map entries needed.

Wraps [@wasm-audio-decoders/ogg-vorbis](https://github.com/eshaz/wasm-audio-decoders).

```js
import decode, { decoder } from '@audio/decode-vorbis'

// whole-file
let { channelData, sampleRate } = await decode(oggbuf)

// streaming
let dec = await decoder()
let a = dec.decode(chunk1)
let b = dec.decode(chunk2)
let c = dec.flush()
dec.free()
```

## Metadata

Read Vorbis comment tags (and cover art) without decoding audio:

```js
import { parseMeta } from '@audio/decode-vorbis/meta'

let { meta, sampleRate } = parseMeta(oggBytes)
// meta: { title, artist, album, year, genre, ..., pictures }
```

## License

[MIT](./LICENSE) · [ॐ](https://github.com/krishnized/license/)
