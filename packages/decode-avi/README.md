# @audio/decode-avi

Decode the audio stream of AVI files to PCM float samples.<br>
A pure-JS RIFF/AVI demuxer (OpenDML `AVIX` extensions included) that skips the video stream and routes the audio to the matching codec package, loaded on demand.

[![npm install @audio/decode-avi](https://nodei.co/npm/@audio/decode-avi.png?mini=true)](https://npmjs.org/package/@audio/decode-avi/)

```js
import decode, { decoder } from '@audio/decode-avi'

let { channelData, sampleRate } = await decode(aviBytes)

let dec = await decoder()
let head = await dec.decode(chunk1)   // Promise on the chunk that completes the stream headers
let more = dec.decode(chunk2)         // synchronous from then on
let tail = await dec.flush()
dec.free()
```

## Codecs

| `wFormatTag` | Codec | Decoded by |
|---|---|---|
| `0x0001`, `0x0003` (and `WAVE_FORMAT_EXTENSIBLE`) | PCM 8–32 bit int, 32/64 bit float | built in |
| `0x0006`, `0x0007` | G.711 A-law, µ-law | built in |
| `0x0055` | MP3 | [@audio/decode-mp3](../decode-mp3) |
| `0x00FF` | AAC | [@audio/decode-aac](../decode-aac) |
| `0x2000` | AC-3 | [@audio/decode-ac3](../decode-ac3) |
| `0x2001` | DTS | [@audio/decode-dts](../decode-dts) |

WMA and ADPCM streams throw an error naming the codec. The first `auds` stream is decoded.

Codec packages are imported dynamically, which is unavailable inside an AudioWorklet — decode in the main thread or a Worker.

## API

### `decode(src: Uint8Array | ArrayBuffer): Promise<AudioData>`

Decode a complete file.

### `decoder(): Promise<AVIDecoder>`

Streaming decoder. `decode(chunk)` returns `AudioData`, or a Promise of it on the chunk that completes the stream headers while the codec module loads. `flush()` returns remaining samples and throws if no audio stream was found. `free()` releases codec resources.

### `AudioData`

```ts
{ channelData: Float32Array[], sampleRate: number }
```

## License

[ॐ](https://github.com/krishnized/license/) · [MIT](./LICENSE). Codec packages carry their own licenses.
