# @audio/decode-wav

> WAV/RIFF decoder — pure JS, streaming-capable; PCM 8/16/24/32-bit int, float32/64, A-law/µ-law.

`npm install @audio/decode-wav`

```js
import decode from '@audio/decode-wav'
let { channelData, sampleRate } = await decode(bytes)   // Uint8Array | ArrayBuffer
```

Also: `decoder()` → streaming half per the codec convention; `./meta` subpath parses embedded metadata; `./audio` manifest plugs the codec into [`audio`](https://github.com/audiojs/audio).

Part of [@audio/decode](https://github.com/audiojs/decode).
