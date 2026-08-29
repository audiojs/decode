# @audio/decode [![test](https://github.com/audiojs/decode/actions/workflows/test.js.yml/badge.svg)](https://github.com/audiojs/decode/actions/workflows/test.js.yml)

Try it in the browser: [Extract audio from video](https://audiojs.dev/util/extract-audio/), [Audio converter](https://audiojs.dev/util/convert-audio/). Runs on this package, nothing is uploaded.

Decode any audio format to raw samples.<br>
JS / WASM with no ffmpeg or native bindings; works in Node.js and browsers.<br>
Small API, minimal size, near-native performance, lazy-loading, chunked decoding.

[![npm install @audio/decode](https://nodei.co/npm/@audio/decode.png?mini=true)](https://npmjs.org/package/@audio/decode/)

```js
import decode from '@audio/decode';

const { channelData, sampleRate } = await decode(anyAudioBuffer);
```

#### Supported formats

| Format | Package | Size | Engine |
|--------|---------|------|--------|
| MP3 | [@audio/decode-mp3](./packages/decode-mp3) | 92 KB | WASM |
| WAV | [@audio/decode-wav](./packages/decode-wav) | 11 KB | JS |
| OGG Vorbis | [@audio/decode-vorbis](./packages/decode-vorbis) | 166 KB | WASM |
| FLAC | [@audio/decode-flac](./packages/decode-flac) | 135 KB | WASM |
| Opus | [@audio/decode-opus](./packages/decode-opus) | 166 KB | WASM |
| M4A / AAC / ALAC | [@audio/decode-aac](./packages/decode-aac) | 368 KB | WASM + JS |
| MP4 / MOV / M4V / 3GP video | [@audio/decode-mp4](./packages/decode-mp4) | 12 KB + codec | JS demux |
| QOA | [@audio/decode-qoa](./packages/decode-qoa) | 8 KB | JS |
| AIFF | [@audio/decode-aiff](./packages/decode-aiff) | 20 KB | JS |
| CAF | [@audio/decode-caf](./packages/decode-caf) | 9 KB | JS |
| WebM / MKV video | [@audio/decode-webm](./packages/decode-webm) | 250 KB | WASM |
| AVI video | [@audio/decode-avi](./packages/decode-avi) | 8 KB + codec | JS demux |
| AC-3 | [@audio/decode-ac3](./packages/decode-ac3) | 43 KB | WASM |
| DTS | [@audio/decode-dts](./packages/decode-dts) | 200 KB | WASM |
| E-AC-3 (Dolby Digital Plus, + AC-3) | [@audio/decode-eac3](./packages/decode-eac3) | 432 KB | WASM (FFmpeg libavcodec, LGPL) |
| APE (Monkey's Audio) | [@audio/decode-ape](./packages/decode-ape) | 262 KB | WASM (FFmpeg libavcodec, LGPL) |
| AMR | [@audio/decode-amr](./packages/decode-amr) | 241 KB | WASM |
| WMA | [@audio/decode-wma](./packages/decode-wma) | 91 KB | WASM |
| WavPack | [@audio/decode-wavpack](./packages/decode-wavpack) | 51 KB | WASM |
| TTA (True Audio) | [@audio/decode-tta](./packages/decode-tta) | 11 KB | JS |
| Musepack SV7 / SV8 | [@audio/decode-mpc](./packages/decode-mpc) | 51 KB | WASM |
| MOD / XM / S3M / IT tracker modules | [@audio/decode-mod](./packages/decode-mod) | 1.4 MB | WASM (libopenmpt) |
| DSF / DFF (DSD64–512 → PCM) | [@audio/decode-dsd](./packages/decode-dsd) | 18 KB | JS |

### Whole-file

Auto-detects format. Input can be _ArrayBuffer_, _Uint8Array_, _Buffer_, or anything
that materializes to bytes, including a _Blob_/_File_ or fetch _Response_.

```js
import decode from '@audio/decode'

let { channelData, sampleRate } = await decode(buf)
let fromFile = await decode(fileInput.files[0])   // File
let fromUrl  = await decode(await fetch(url))      // Response
```

### Chunked

```js
let dec = await decode.mp3()
let a = await dec(chunk1)    // { channelData, sampleRate }
let b = await dec(chunk2)
await dec()                  // close
```

### Streaming

```js
import decode from '@audio/decode'

for await (let { channelData, sampleRate } of decode.mp3(response.body)) {
  // process chunks
}
```

Works with `ReadableStream`, `fetch` body, Node stream, or any async iterable.

Formats: `mp3`, `flac`, `opus`, `oga`, `m4a`, `mp4`, `mov`, `wav`, `qoa`, `aac`, `aiff`, `caf`, `webm`, `mkv`, `avi`, `ac3`, `dts`, `amr`, `wma`, `eac3`, `ape`, `wv`, `tta`, `mpc`, `dsf`, `dff`, `mod`, `xm`, `s3m`, `it`.

### Video files

Video containers decode straight to their audio track — the video stream is skipped, no ffmpeg involved:

```js
let { channelData, sampleRate } = await decode(await fetch('trailer.mp4'))
```

| Container | Package | Audio codecs |
|---|---|---|
| MP4, MOV, M4V, 3GP | [@audio/decode-mp4](./packages/decode-mp4) | AAC, ALAC, MP3, FLAC, Opus, AC-3, DTS, AMR, PCM, G.711 |
| WebM, MKV | [@audio/decode-webm](./packages/decode-webm) | Opus, Vorbis, AAC, ALAC, MP3, FLAC, AC-3, DTS, PCM |
| AVI | [@audio/decode-avi](./packages/decode-avi) | PCM, MP3, AAC, AC-3, DTS, G.711 |

Surround tracks keep their layout (up to 5.1, WAV channel order). E-AC-3 and TrueHD tracks throw an error naming the codec.

### Browser

Works from a CDN without a bundler. Codecs load on demand via dynamic import, only for formats you decode:

```html
<script type="module">
  import decode from 'https://esm.sh/@audio/decode'
  let { channelData, sampleRate } = await decode(buf)
</script>
```

For self-hosting, use an import map to point `@audio/decode` and each needed `@audio/decode-*` package to local files. Codec-internal files load by relative path.

Each codec package's main export works in an `AudioWorklet` without `Blob`, `TextDecoder`, `Worker`, or `fetch`. Import codec packages directly because `@audio/decode` uses dynamic imports.

Initialize WASM before rendering. Decoding runs on the worklet thread and can interrupt audio output.

### Synchronous codecs

The umbrella remains async for detection, lazy imports, and `Blob`/`Response` inputs.
Import a codec package directly for synchronous calls.

`wav`, `qoa`, `aiff`, and `caf` are synchronous:

```js
import decode from '@audio/decode-wav'
let pcm = decode(wavBytes)
```

WASM codecs initialize asynchronously, then decode synchronously:

```js
import { decoder } from '@audio/decode-flac'
let dec = await decoder()
let pcm = dec.decode(bytes)
let tail = dec.flush()
dec.free()
```

### Metadata

Read tags, pictures, markers and regions without decoding samples. Available for
`wav`, `mp3`, `flac`, `oga` (Ogg Vorbis), `opus`, and `m4a`.

```js
import { wav, mp3, flac, oga, opus, m4a } from '@audio/decode/meta'

let { meta, sampleRate, markers, regions } = mp3(bytes)
// meta: { title, artist, album, year, bpm, key, comment, pictures, raw, ... }
// markers: [{ sample, label }]
// regions: [{ sample, length, label }]
```

Each codec sub-package also exposes its parser directly:

```js
import { parseMeta } from '@audio/decode-wav/meta'
let info = parseMeta(wavBytes)
```

### WebWorker

Each `@audio/decode-*` package is a self-contained ESM module that can run in a worker:

```js
// decode-worker.js
import decode from '@audio/decode-mp3'

self.onmessage = async ({ data }) => {
  let pcm = await decode(data)
  self.postMessage(pcm, pcm.channelData.map(ch => ch.buffer))
}

// main.js
let worker = new Worker('./decode-worker.js', { type: 'module' })
worker.postMessage(mp3buf, [mp3buf])
worker.onmessage = ({ data }) => { /* { channelData, sampleRate } */ }
```

## See also

* [encode](https://github.com/audiojs/encode) – encode PCM into any audio format.
* [audio-type](https://github.com/audiojs/audio-type) – detect audio format from buffer.
<!--
* [wasm-audio-decoders](https://github.com/eshaz/wasm-audio-decoders) – compact & fast WASM audio decoders.
* [AudioDecoder](https://developer.mozilla.org/en-US/docs/Web/API/AudioDecoder) – native WebCodecs decoder API.
* [decodeAudioData](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData) – built-in browser decoding method.
* [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) – full encoding/decoding library.
-->

## Licensing

The umbrella and most codec packages are MIT. Codecs built on other libraries carry that library's license: <a href="./packages/decode-aac">@audio/decode-aac</a> GPL-2.0; <a href="./packages/decode-wma">@audio/decode-wma</a>, <a href="./packages/decode-ac3">@audio/decode-ac3</a> and <a href="./packages/decode-dts">@audio/decode-dts</a> GPL-2.0-or-later; <a href="./packages/decode-ape">@audio/decode-ape</a> and <a href="./packages/decode-eac3">@audio/decode-eac3</a> LGPL-2.1-or-later (a slim FFmpeg libavcodec build, no GPL components); <a href="./packages/decode-wavpack">@audio/decode-wavpack</a>, <a href="./packages/decode-mpc">@audio/decode-mpc</a> and <a href="./packages/decode-mod">@audio/decode-mod</a> BSD-3-Clause; <a href="./packages/decode-amr">@audio/decode-amr</a> Apache-2.0. Install only the codecs whose licenses fit your project. The umbrella loads them on demand.

<p align="center"><a href="https://github.com/krishnized/license/">ॐ</a> · <a href="./LICENSE">MIT</a>
