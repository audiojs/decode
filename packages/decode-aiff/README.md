# @audio/decode-aiff

Decode AIFF and AIFF-C audio to PCM float samples.<br>
Part of [decode](https://github.com/audiojs/decode).

## Install

```
npm i @audio/decode-aiff
```

## Usage

```js
import decode from '@audio/decode-aiff'

let { channelData, sampleRate } = await decode(aiffBuffer)
// channelData: Float32Array[] (one per channel)
// sampleRate: number
```

### Streaming

```js
import { decoder } from '@audio/decode-aiff'

let dec = await decoder()
let result = dec.decode(chunk)
dec.free()
```

## API

### `decode(src): Promise<AudioData>`

Whole-file decode. Accepts `Uint8Array` or `ArrayBuffer`.

### `decoder(): Promise<AIFFDecoder>`

Creates a decoder instance.

- **`dec.decode(data)`** — decode chunk, returns `{ channelData, sampleRate }`
- **`dec.flush()`** — flush (returns empty — AIFF is stateless)
- **`dec.free()`** — release resources

## Formats

- AIFF — 8, 16, 24, 32-bit signed integer PCM (big-endian)
- AIFF-C — `NONE`/`twos` (BE PCM), `sowt` (LE PCM), `fl32`/`fl64` (float), `alaw`, `ulaw`

## License

MIT — [krishnized](https://github.com/krishnized/license)
