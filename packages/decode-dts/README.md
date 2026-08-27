# @audio/decode-dts

Decode DTS (DTS Coherent Acoustics) to PCM float samples.<br>
[libdca](https://code.videolan.org/videolan/libdca) compiled to a single-file WASM ES module — no side files, loads from any CDN, Node, workers and AudioWorklets.

[![npm install @audio/decode-dts](https://nodei.co/npm/@audio/decode-dts.png?mini=true)](https://npmjs.org/package/@audio/decode-dts/)

```js
import decode, { decoder } from '@audio/decode-dts'

let { channelData, sampleRate } = await decode(dtsBytes)

let dec = await decoder()
let head = dec.decode(chunk1)   // synchronous; partial frames carry over
let tail = dec.flush()
dec.free()
```

Input is a raw DTS core frame stream (`.dts`, or the frames a container demuxer extracts — [@audio/decode-mp4](../decode-mp4), [@audio/decode-webm](../decode-webm) and [@audio/decode-avi](../decode-avi) route their DTS tracks here). The stream's own layout is kept, up to 5.1; channels come out in WAV order: FL, FR, FC, LFE, BL, BR (surround-only or mono as present). Output level is full scale,  

DTS-HD Master Audio and High Resolution streams decode through their lossy core; the extension substreams are skipped. 14-bit and little-endian sync variants are handled.

## API

### `decode(src: Uint8Array | ArrayBuffer): Promise<AudioData>`

Decode a complete stream.

### `decoder(): Promise<DTSDecoder>`

Synchronous streaming decoder: `decode(chunk)` returns the samples of every complete frame in the data so far, `flush()` drops a trailing partial frame, `free()` releases WASM memory. `errors` counts frames that failed to decode.

### `AudioData`

```ts
{ channelData: Float32Array[], sampleRate: number }
```

## License

[ॐ](https://github.com/krishnized/license/) · [GPL-2.0-or-later](./LICENSE), inherited from the bundled [libdca](./LICENSE.libdca).
