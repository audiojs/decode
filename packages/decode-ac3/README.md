# @audio/decode-ac3

Decode AC-3 (Dolby Digital) to PCM float samples.<br>
[liba52](https://code.videolan.org/videolan/liba52) compiled to a single-file WASM ES module — no side files, loads from any CDN, Node, workers and AudioWorklets.

[![npm install @audio/decode-ac3](https://nodei.co/npm/@audio/decode-ac3.png?mini=true)](https://npmjs.org/package/@audio/decode-ac3/)

```js
import decode, { decoder } from '@audio/decode-ac3'

let { channelData, sampleRate } = await decode(ac3Bytes)

let dec = await decoder()
let head = dec.decode(chunk1)   // synchronous; partial frames carry over
let tail = dec.flush()
dec.free()
```

Input is a raw AC-3 frame stream (`.ac3`, or the frames a container demuxer extracts — [@audio/decode-mp4](../decode-mp4), [@audio/decode-webm](../decode-webm) and [@audio/decode-avi](../decode-avi) route their AC-3 tracks here). The stream's own layout is kept, up to 5.1; channels come out in WAV order: FL, FR, FC, LFE, BL, BR (surround-only or mono as present). Output level is full scale, no dialnorm applied.

E-AC-3 (Dolby Digital Plus) is a different codec and is not decoded.

## API

### `decode(src: Uint8Array | ArrayBuffer): Promise<AudioData>`

Decode a complete stream.

### `decoder(): Promise<AC3Decoder>`

Synchronous streaming decoder: `decode(chunk)` returns the samples of every complete frame in the data so far, `flush()` drops a trailing partial frame, `free()` releases WASM memory. `errors` counts frames that failed to decode.

### `AudioData`

```ts
{ channelData: Float32Array[], sampleRate: number }
```

## License

[ॐ](https://github.com/krishnized/license/) · [GPL-2.0-or-later](./LICENSE), inherited from the bundled [liba52](./LICENSE.liba52).
