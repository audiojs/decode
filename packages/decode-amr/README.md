# @audio/decode-amr

Decode AMR-NB and AMR-WB audio to PCM float samples with [opencore-amr](https://sourceforge.net/projects/opencore-amr/) WASM.

## Install

```
npm i @audio/decode-amr
```

## Usage

```js
import decode from '@audio/decode-amr'

// AMR-NB or AMR-WB; auto-detected from the file header
let { channelData, sampleRate } = await decode(amrBuffer)
// AMR-NB: 8000 Hz mono
// AMR-WB: 16000 Hz mono
```

### Streaming

```js
import { decoder } from '@audio/decode-amr'

let dec = await decoder()
let result = dec.decode(chunk)
dec.free()
```

`decoder()` is asynchronous. Its `decode()` and `flush()` methods are synchronous.

## API

### `decode(src): Promise<AudioData>`

Whole-file decode. Accepts `Uint8Array` or `ArrayBuffer`. Auto-detects AMR-NB (`#!AMR\n`) vs AMR-WB (`#!AMR-WB\n`).

### `decoder(): Promise<AMRDecoder>`

Creates a decoder instance.

- `dec.decode(data)`: decode a `Uint8Array` or `ArrayBuffer` chunk.
- `dec.flush()`: discard buffered partial data and return an empty result.
- `dec.free()`: release WASM memory.

## Formats

- AMR-NB: 8 kHz, modes 0–7 (4.75–12.2 kbps)
- AMR-WB: 16 kHz, modes 0–8 (6.6–23.85 kbps)

## Building WASM

The WASM module is prebuilt in `src/amr.wasm.js`. To rebuild:

```
npm run build
```

This auto-fetches opencore-amr 0.1.6 source and compiles with Emscripten.

## License

[ॐ](https://github.com/krishnized/license/) · [Apache-2.0](./LICENSE) (opencore-amr)
