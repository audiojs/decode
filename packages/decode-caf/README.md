# @audio/decode-caf

Decode Core Audio Format (CAF) audio to PCM float samples.

Part of [audio-decode](https://github.com/audiojs/audio-decode).

## Install

```
npm i @audio/decode-caf
```

## Usage

```js
import decode from '@audio/decode-caf'

let { channelData, sampleRate } = await decode(cafBuffer)
```

### Streaming

```js
import { decoder } from '@audio/decode-caf'

let dec = await decoder()
let result = dec.decode(chunk)
dec.free()
```

## API

### `decode(src): Promise<AudioData>`

Whole-file decode. Accepts `Uint8Array` or `ArrayBuffer`.

### `decoder(): Promise<CAFDecoder>`

Creates a decoder instance.

- **`dec.decode(data)`** — decode chunk, returns `{ channelData, sampleRate }`
- **`dec.flush()`** — flush (returns empty — CAF is stateless)
- **`dec.free()`** — release resources

## Formats

- `lpcm` — 8, 16, 24, 32-bit signed integer (LE/BE), 32/64-bit float (LE/BE)
- `alaw` — G.711 A-law
- `ulaw` — G.711 mu-law
- `ima4` — IMA/QuickTime ADPCM (iOS Voice Memos, GarageBand)

## License

MIT

<a href="https://github.com/krishnized/license/">ॐ</a>
