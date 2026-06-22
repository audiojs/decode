# @audio/decode-aac

Decode AAC/M4A and ALAC (Apple Lossless) audio to PCM float samples. AAC via FAAD2 (WASM); ALAC via a pure-JS port of Apple's reference decoder — auto-detected from the M4A sample entry. Works in Node.js and browsers, no native dependencies.

## Install

```
npm i @audio/decode-aac
```

## Usage

```js
import decode from '@audio/decode-aac'

// M4A or raw ADTS — auto-detected
let { channelData, sampleRate } = await decode(uint8array)
// channelData: Float32Array[] (one per channel)
// sampleRate: number
```

### Streaming

```js
import { decoder } from '@audio/decode-aac'

let dec = await decoder()
let { channelData, sampleRate } = dec.decode(chunk)
dec.free()
```

## API

### `decode(src: Uint8Array | ArrayBuffer): Promise<AudioData>`

Whole-file decode. Auto-detects M4A (MP4 container) vs raw ADTS.

### `decoder(): Promise<AACDecoder>`

Creates a decoder instance for manual control.

- **`dec.decode(data)`** — decode chunk, returns `{ channelData, sampleRate }`
- **`dec.flush()`** — flush remaining (returns empty for AAC)
- **`dec.free()`** — release WASM memory

### `AudioData`

```ts
{ channelData: Float32Array[], sampleRate: number }
```

## Formats

- M4A / MP4 with AAC audio (LC, HE-AAC v1/v2 — SBR, PS)
- M4A / MP4 with ALAC (Apple Lossless), 16/20/24/32-bit — pure JS, bit-exact
- Raw ADTS streams (.aac)

## Metadata

```js
import { parseMeta } from '@audio/decode-aac/meta'

let { meta, sampleRate } = parseMeta(m4aBytes)
// meta: { title, artist, album, year, genre, track, ..., pictures }
```

## License

AAC decoding: GPL-2.0 (FAAD2). ALAC decoding: Apache-2.0 (port of Apple's ALAC reference). — [krishnized](https://github.com/krishnized/license)
