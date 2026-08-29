# @audio/decode-eac3

Decode E-AC-3 (Dolby Digital Plus) — and plain AC-3 — to PCM float samples.<br>
FFmpeg's `eac3` decoder — a slim LGPL-2.1-or-later `libavcodec`/`libavutil` build (no GPL components) — compiled to a single-file WASM ES module. No side files, loads from any CDN, Node, workers and AudioWorklets.

[![npm install @audio/decode-eac3](https://nodei.co/npm/@audio/decode-eac3.png?mini=true)](https://npmjs.org/package/@audio/decode-eac3/)

```js
import decode, { decoder } from '@audio/decode-eac3'

let { channelData, sampleRate } = await decode(eac3Bytes)

let dec = await decoder()
let head = dec.decode(chunk1)   // synchronous; partial frames carry over
let tail = dec.flush()
dec.free()
```

E-AC-3 (Dolby Digital Plus) is specified in [ATSC A/52:2018 Annex E](https://www.atsc.org/atsc-documents/a522018-digital-audio-compression-ac-3-e-ac-3/). FFmpeg's `eac3` decoder shares its core with `ac3dec.c` and dispatches on the bitstream's own `bitstream_id` field (`bsid ≤ 10` → classic AC-3 syntax, `bsid = 16` → E-AC-3), so **this package decodes both** raw AC-3 and E-AC-3 sync-frame streams (`.ac3`, `.ec3`, `.eac3`) — container demuxers ([@audio/decode-mp4](../decode-mp4), [@audio/decode-webm](../decode-webm), [@audio/decode-avi](../decode-avi)) route their E-AC-3 tracks here. Sync frames (syncword `0x0B77`) are cut in JS using FFmpeg's own public `av_ac3_parse_header` for the frame length (`frmsiz` for E-AC-3, the `frmsizecod`/`fscod` table for classic AC-3) — same shape as [@audio/decode-ac3](../decode-ac3).

Up to 5.1 (7.1 with dependent-substream channel maps FFmpeg supports), channels come out in WAV order already: FFmpeg's `ac3dec.c` builds a native (bitmask) `AVChannelLayout` for every decoded frame, and native layouts enumerate channels in ascending `AV_CH_*` bit order — which *is* WAV order (FL, FR, FC, LFE, BL, BR, …; FFmpeg labels AC-3/E-AC-3's rear pair `SIDE_LEFT`/`SIDE_RIGHT` rather than `BACK_LEFT`/`BACK_RIGHT`, but the bit position — and so the output slot — is the same). No downmix is requested, so the stream's own channel count is preserved.

Dynamic range compression (`drc_scale`) is forced to `0`, disabling it — FFmpeg's AC-3 decoder applies it by default (`drc_scale = 1.0`). `@audio/decode-ac3` (liba52) never applies dialnorm or DRC either; forcing it off here keeps output level comparable between the two packages for the same AC-3 input — verified in `test.js` (RMS within ±0.5 dB on `../decode-ac3/fixtures/stereo.ac3`, decoded by both). Neither package applies dialnorm — FFmpeg's `ac3dec.c` doesn't read or apply it at all, only DRC.

## API

### `decode(src: Uint8Array | ArrayBuffer): Promise<AudioData>`

Decode a complete stream.

### `decoder(): Promise<Eac3Decoder>`

Synchronous streaming decoder: `decode(chunk)` returns the samples of every complete frame in the data so far, `flush()` drops a trailing partial frame, `free()` releases WASM memory. `errors` counts frames that failed to decode.

### `AudioData`

```ts
{ channelData: Float32Array[], sampleRate: number }
```

**Use when:** you need to play or transcode E-AC-3 (Dolby Digital Plus) — or AC-3 — in the browser or Node.

## License

[ॐ](https://github.com/krishnized/license/) · [LGPL-2.1-or-later](./LICENSE), inherited from the bundled [FFmpeg](https://ffmpeg.org/legal.html) `eac3`/`ac3` decoder (built without `--enable-gpl` — see [`build.sh`](./build.sh) and [`LICENSE.ffmpeg`](./LICENSE.ffmpeg)). FFmpeg source: the shared [`lib/ffmpeg`](../../lib/ffmpeg) submodule (`release/7.1`), also used by [`@audio/decode-ape`](../decode-ape).
