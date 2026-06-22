# audio-decode [![test](https://github.com/audiojs/audio-decode/actions/workflows/test.js.yml/badge.svg)](https://github.com/audiojs/audio-decode/actions/workflows/test.js.yml)

Decode any audio format to raw samples.<br>
JS / WASM – no ffmpeg, no native bindings, works in both node and browser.<br>
Small API, minimal size, near-native performance, lazy-loading, chunked decoding.

[![npm install audio-decode](https://nodei.co/npm/audio-decode.png?mini=true)](https://npmjs.org/package/audio-decode/)

```js
import decode from 'audio-decode';

const { channelData, sampleRate } = await decode(anyAudioBuffer);
```

#### Supported formats

| Format | Package | Size | Engine |
|--------|---------|------|--------|
| MP3 | [@audio/decode-mp3](./packages/decode-mp3) | 92 KB | WASM |
| WAV | [@audio/decode-wav](./packages/decode-wav) | 4 KB | JS |
| OGG Vorbis | [@audio/decode-vorbis](./packages/decode-vorbis) | 164 KB | WASM |
| FLAC | [@audio/decode-flac](./packages/decode-flac) | 133 KB | WASM |
| Opus | [@audio/decode-opus](./packages/decode-opus) | 178 KB | WASM |
| M4A / AAC / ALAC | [@audio/decode-aac](./packages/decode-aac) | 368 KB | WASM + JS |
| QOA | [@audio/decode-qoa](./packages/decode-qoa) | 8 KB | JS |
| AIFF | [@audio/decode-aiff](./packages/decode-aiff) | 20 KB | JS |
| CAF | [@audio/decode-caf](./packages/decode-caf) | 7 KB | JS |
| WebM | [@audio/decode-webm](./packages/decode-webm) | 263 KB | WASM |
| AMR | [@audio/decode-amr](./packages/decode-amr) | 241 KB | WASM |
| WMA | [@audio/decode-wma](./packages/decode-wma) | 91 KB | WASM |

### Whole-file

Auto-detects format. Input can be _ArrayBuffer_, _Uint8Array_, _Buffer_, or anything
that materializes to bytes — a _Blob_/_File_ (browser file input, drag-drop) or a fetch _Response_.

```js
import decode from 'audio-decode'

let { channelData, sampleRate } = await decode(buf)
let fromFile = await decode(fileInput.files[0])   // File
let fromUrl  = await decode(await fetch(url))      // Response
```

WAV covers PCM (8/16/24/32-bit int, 32/64-bit float), WAVE_FORMAT_EXTENSIBLE,
G.711 A-law/µ-law, and IMA/MS ADPCM. CAF covers LPCM, A-law/µ-law, and IMA4.
M4A decodes both AAC and ALAC (Apple Lossless) transparently.

### Chunked

```js
let dec = await decode.mp3()
let a = await dec(chunk1)    // { channelData, sampleRate }
let b = await dec(chunk2)
await dec()                  // close
```

### Streaming

```js
import decode from 'audio-decode'

for await (let { channelData, sampleRate } of decode.mp3(response.body)) {
  // process chunks
}
```

Works with `ReadableStream`, `fetch` body, Node stream, or any async iterable.

Formats: `mp3`, `flac`, `opus`, `oga`, `m4a`, `wav`, `qoa`, `aac`, `aiff`, `caf`, `webm`, `amr`, `wma`.

### Browser

Each codec is a self-contained bundle under `@audio/*` — no transitive deps, no import map bloat.
For selective loading in the browser (avoids bundling all codecs):

```html
<script type="importmap">
{
  "imports": {
    "audio-decode": "https://esm.sh/audio-decode",
    "audio-type": "https://esm.sh/audio-type",
    "@audio/decode-mp3": "https://esm.sh/@audio/decode-mp3",
    "@audio/decode-wav": "https://esm.sh/@audio/decode-wav",
    "@audio/decode-flac": "https://esm.sh/@audio/decode-flac",
    "@audio/decode-opus": "https://esm.sh/@audio/decode-opus",
    "@audio/decode-vorbis": "https://esm.sh/@audio/decode-vorbis",
    "@audio/decode-aac": "https://esm.sh/@audio/decode-aac",
    "@audio/decode-qoa": "https://esm.sh/@audio/decode-qoa",
    "@audio/decode-aiff": "https://esm.sh/@audio/decode-aiff",
    "@audio/decode-caf": "https://esm.sh/@audio/decode-caf",
    "@audio/decode-webm": "https://esm.sh/@audio/decode-webm",
    "@audio/decode-amr": "https://esm.sh/@audio/decode-amr",
    "@audio/decode-wma": "https://esm.sh/@audio/decode-wma"
  }
}
</script>
<script type="module">
  import decode from 'audio-decode'
  let { channelData, sampleRate } = await decode(buf)
</script>
```

Only list the codecs you need — each `@audio/decode-*` package bundles all its WASM/JS deps internally.

### Metadata

Read tags, pictures, markers and regions without decoding samples. Available for
`wav`, `mp3`, `flac`, `oga` (Ogg Vorbis), `opus`, and `m4a`.

```js
import { wav, mp3, flac, oga, opus, m4a } from 'audio-decode/meta'

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

Each `@audio/decode-*` package is a self-contained ESM module — import directly in a worker:

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

* [audio-encode](https://github.com/audiojs/audio-encode) – encode PCM into any audio format.
* [audio-type](https://github.com/audiojs/audio-type) – detect audio format from buffer.
<!--
* [wasm-audio-decoders](https://github.com/eshaz/wasm-audio-decoders) – compact & fast WASM audio decoders.
* [AudioDecoder](https://developer.mozilla.org/en-US/docs/Web/API/AudioDecoder) – native WebCodecs decoder API.
* [decodeAudioData](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData) – built-in browser decoding method.
* [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) – full encoding/decoding library.
-->

<p align="center"><a href="./LICENSE">MIT</a> • <a href="https://github.com/krishnized/license/">ॐ</a>
