# @audio/decode-wma

Decode WMA audio to PCM float samples. ASF demuxer in pure JS, WMA decoding via [RockBox](https://www.rockbox.org/) fixed-point decoder compiled to WASM (70 KB).

Part of [decode](https://github.com/audiojs/decode).

## Install

```
npm i @audio/decode-wma
```

## Usage

```js
import decode from '@audio/decode-wma'

let { channelData, sampleRate } = await decode(wmaBuffer)
```

### Streaming

```js
import { decoder } from '@audio/decode-wma'

let dec = await decoder()
let result = dec.decode(chunk)
dec.free()
```

### ASF demuxer only

```js
import { demuxASF } from '@audio/decode-wma'

let { channels, sampleRate, bitRate, packets } = demuxASF(buffer)
```

## API

### `decode(src): Promise<AudioData>`

Whole-file decode. Accepts `Uint8Array` or `ArrayBuffer`.

### `decoder(): Promise<WMADecoder>`

Creates a decoder instance.

- **`dec.decode(data)`** — decode chunk, returns `{ channelData, sampleRate }`
- **`dec.flush()`** — flush (returns empty)
- **`dec.free()`** — release WASM memory

### `demuxASF(buf): ASFInfo`

Parse ASF container without decoding. Returns stream properties and raw packets.

## Formats

- WMA v1 (0x0160)
- WMA v2 (0x0161)

WMA Pro and Lossless are not supported. An FFmpeg-based build is available via `build-ffmpeg.sh` for those formats.

## Building WASM

```
npm run build
```

RockBox source is included in `lib/rockbox-wma/` (3 files, 152 KB).

## License

GPL-2.0+ (RockBox)

<a href="https://github.com/krishnized/license/">ॐ</a>
