# @audio/decode-webm

Decode WebM audio (Opus and Vorbis) to PCM float samples. EBML demuxer in pure JS, codec decoding via WASM.

Part of [decode](https://github.com/audiojs/decode).

## Install

```
npm i @audio/decode-webm
```

## Usage

```js
import decode from '@audio/decode-webm'

let { channelData, sampleRate } = await decode(webmBuffer)
```

### Streaming

```js
import { decoder } from '@audio/decode-webm'

let dec = await decoder()
let result = await dec.decode(chunk)
let flushed = await dec.flush()
dec.free()
```

## API

### `decode(src): Promise<AudioData>`

Whole-file decode. Accepts `Uint8Array` or `ArrayBuffer`.

### `decoder(): Promise<WebmDecoder>`

Creates a decoder instance.

- **`dec.decode(data)`** — decode chunk, returns `Promise<AudioData>`
- **`dec.flush()`** — flush remaining data
- **`dec.free()`** — release resources

Note: `decode()` and `flush()` are async (unlike the sync PCM decoders) because Opus decoding happens in WASM.

## Codecs

- **Opus** — via [opus-decoder](https://github.com/eshaz/wasm-audio-decoders)
- **Vorbis** — via [@wasm-audio-decoders/ogg-vorbis](https://github.com/eshaz/wasm-audio-decoders) (raw frames wrapped in OGG pages)

## License

MIT

<a href="https://github.com/krishnized/license/">ॐ</a>
