# @audio/decode-mp4

Decode the audio track of MP4, MOV, M4A, M4V and 3GP files to PCM float samples.<br>
A pure-JS ISO BMFF demuxer that skips the video track and routes the audio (AAC, ALAC, MP3, FLAC, Opus, AC-3, DTS, AMR, PCM) to the matching codec package, loaded on demand.

[![npm install @audio/decode-mp4](https://nodei.co/npm/@audio/decode-mp4.png?mini=true)](https://npmjs.org/package/@audio/decode-mp4/)

```js
import decode, { decoder } from '@audio/decode-mp4'

let { channelData, sampleRate } = await decode(mp4Bytes)

let dec = await decoder()
let head = await dec.decode(chunk1)   // Promise on the chunk that completes the track header
let more = dec.decode(chunk2)         // synchronous from then on
let tail = await dec.flush()
dec.free()
```

## Codecs

| Sample entry | Codec | Decoded by |
|---|---|---|
| `mp4a` (esds object type 0x40, 0x66–0x68) | AAC-LC, HE-AAC v1/v2 | [@audio/decode-aac](../decode-aac) |
| `alac` | Apple Lossless | [@audio/decode-aac](../decode-aac) (pure JS) |
| `mp4a` (0x69, 0x6B), `.mp3` | MP3 | [@audio/decode-mp3](../decode-mp3) |
| `fLaC` | FLAC | [@audio/decode-flac](../decode-flac) |
| `Opus` | Opus | [@audio/decode-opus](../decode-opus) |
| `samr`, `sawb` | AMR-NB, AMR-WB | [@audio/decode-amr](../decode-amr) |
| `sowt`, `twos`, `in24`, `in32`, `fl32`, `fl64`, `lpcm`, `ipcm`, `fpcm`, `raw `, `NONE` | PCM 8–32 bit int, 32/64 bit float, either endianness | built in |
| `ulaw`, `alaw` | G.711 | built in |
| `ac-3`, `mp4a` (0xA5) | AC-3 | [@audio/decode-ac3](../decode-ac3) |
| `dtsc`, `dtsh`, `dtsl`, `dtse`, `mp4a` (0xA9) | DTS (core) | [@audio/decode-dts](../decode-dts) |
| `ec-3`, `mp4a` (0xA6) | E-AC-3 (Dolby Digital Plus) | [@audio/decode-eac3](../decode-eac3) |

TrueHD tracks throw an error naming the codec. Fragmented MP4 (`moof`) is not supported. QuickTime sound descriptions v0, v1 and v2 are handled, including `wave`-wrapped configs and `enda` endianness flags. When `moov` follows `mdat` (typical of camera and QuickTime output) the file is buffered until the header arrives.

Codec packages are imported dynamically, which is unavailable inside an AudioWorklet — decode in the main thread or a Worker.

## API

### `decode(src: Uint8Array | ArrayBuffer): Promise<AudioData>`

Decode a complete file.

### `decoder(): Promise<MP4Decoder>`

Streaming decoder. `decode(chunk)` returns `AudioData`, or a Promise of it on the chunk that completes the track header while the codec module loads. `flush()` returns remaining samples and throws if no audio track was found. `free()` releases codec resources.

### `AudioData`

```ts
{ channelData: Float32Array[], sampleRate: number }
```

## License

[ॐ](https://github.com/krishnized/license/) · [MIT](./LICENSE). Codec packages carry their own licenses.
