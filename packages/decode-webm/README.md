# @audio/decode-webm

Decode WebM and Matroska (MKV) audio to PCM float samples — the audio track of video files included (Opus, Vorbis, AAC, ALAC, MP3, FLAC, AC-3, DTS, PCM).

## Install

```
npm i @audio/decode-webm
```

## Usage

```js
import decode, { decoder } from '@audio/decode-webm'

let { channelData, sampleRate } = await decode(webmBytes)

let dec = await decoder() // initialize Opus and Vorbis WASM
let result = dec.decode(chunk)
let tail = dec.flush()
dec.free()
```

Video tracks are skipped; the first audio track is decoded. Laced blocks (Xiph, EBML, fixed) are split into frames.

## API

### `decode(src): Promise<AudioData>`

Decode a complete `Uint8Array` or `ArrayBuffer`.

### `decoder(): Promise<WebmDecoder>`

Initialize the codec runtimes and return a streaming decoder. For the WebM codecs (Opus, Vorbis) `decode()` and `flush()` are synchronous. For Matroska-only codecs the call that completes the track header returns a Promise while the codec package loads; later calls are synchronous. `flush()` ends the stream.

The factory prepares the Opus and Vorbis runtimes, then releases what the track does not need once the header is read.

## Codecs

| CodecID | Decoded by |
|---|---|
| `A_OPUS` | bundled libopus WASM core from [@audio/decode-opus](../decode-opus) |
| `A_VORBIS` | bundled [@audio/decode-vorbis](../decode-vorbis) |
| `A_AAC` (all profiles) | [@audio/decode-aac](../decode-aac), loaded on demand |
| `A_ALAC` | [@audio/decode-aac](../decode-aac), loaded on demand |
| `A_MPEG/L3` | [@audio/decode-mp3](../decode-mp3), loaded on demand |
| `A_FLAC` | [@audio/decode-flac](../decode-flac), loaded on demand |
| `A_PCM/INT/LIT`, `A_PCM/INT/BIG`, `A_PCM/FLOAT/IEEE` | built in |
| `A_AC3` | [@audio/decode-ac3](../decode-ac3), loaded on demand |
| `A_DTS` (core of DTS-HD too) | [@audio/decode-dts](../decode-dts), loaded on demand |
| `A_EAC3` | [@audio/decode-eac3](../decode-eac3), loaded on demand |

TrueHD, MPEG Layer I/II, WavPack, TTA and `A_MS/ACM` tracks throw an error naming the codec. `DiscardPadding` on Opus blocks is honoured, so files from @audio/encode-webm decode sample-exact.

On-demand codec packages are imported dynamically, which is unavailable inside an AudioWorklet — Opus and Vorbis work there, the others need the main thread or a Worker.

## License

[ॐ](https://github.com/krishnized/license/) · [MIT](./LICENSE). Bundled [libopus](https://opus-codec.org/) is [BSD 3-Clause](./LICENSE.libopus).
