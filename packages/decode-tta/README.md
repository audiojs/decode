# @audio/decode-tta [![npm](https://img.shields.io/npm/v/@audio/decode-tta)](https://www.npmjs.com/package/@audio/decode-tta) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

Decode TTA (True Audio) lossless audio to PCM samples, in pure JavaScript

```
npm install @audio/decode-tta
```

```js
import decode, { decoder } from '@audio/decode-tta'
```

TTA1 is Alexander Djourik's lossless codec: per channel, an adaptive two-state Rice coder feeds an 8-tap sign-sign-LMS "hybrid" filter and a fixed first-order predictor; multichannel streams decorrelate the last channel against the rest with a cascading half-sum/difference. Written from the [TTA project](https://sourceforge.net/projects/tta/) and the BSD-licensed reference decoder — Djourik & Zhilin, True Audio Software (2004): `ttadec.c` / `filter.h` / `ttadec.h` / `ttalib.h`, via [Rockbox's libtta port](https://github.com/Rockbox/rockbox/tree/master/lib/rbcodec/codecs/libtta) which retains the original license — see [LICENSE.ttadec](./LICENSE.ttadec). Decodes exactly what `ffmpeg -c:a tta` writes: 8/16/24-bit PCM, mono through 16 channels.

```js
let { channelData, sampleRate } = decode(ttaBytes)

let dec = decoder()
let head = dec.decode(chunk1)   // synchronous; header/seek-table/frame boundaries carry over
let tail = dec.flush()
dec.free()
```

## API

### `decode(src: Uint8Array | ArrayBuffer): AudioData`

Decode a complete stream.

### `decoder(): TTADecoder`

Synchronous streaming decoder. `decode(chunk)` returns the samples of every complete frame in the data so far — frame byte lengths are known from the seek table, so a chunk boundary anywhere (even mid-header) just carries over to the next call. `flush()` drops a trailing incomplete header/seek-table/frame. `free()` releases state and is idempotent. `errors` counts frames dropped for a CRC32 mismatch.

### `AudioData`

```ts
{ channelData: Float32Array[], sampleRate: number }
```

## CRC32

TTA1 checksums the header, the seek table, and every frame independently. A header or seek-table mismatch throws — those describe the stream's shape and can't be decoded around. A frame mismatch is not fatal: since each frame resets its filter/predictor/Rice state from scratch, one bad frame can't corrupt its neighbors, so that frame's samples are dropped, `errors` increments, and decoding continues.

## Notes

- Only format 1 (plain PCM) is decoded; format 2 (password-encrypted TTA) throws.
- Channel order is kept exactly as encoded — TTA does not reorder channels the way AC-3/DTS do, so `channelData[i]` is stream channel `i`.
- A leading ID3v2 tag (some encoders other than ffmpeg prepend one) is detected and skipped before the `TTA1` signature; a trailing APEv2 tag is ignored.
- A truncated file loses its final incomplete frame silently, matching `flush()`'s "drop the partial" behavior in the other atoms in this umbrella.
- 60 s of 44.1 kHz stereo decodes in ~225 ms on a current laptop (~265× real-time).

**Use when:** opening `.tta` files, or decoding a TTA track pulled out of a container.

---

Part of [@audio/decode](https://github.com/audiojs/decode) — the decode family umbrella.

MIT © [audiojs](https://github.com/audiojs), algorithm ported from the BSD-licensed TTA reference decoder — see [LICENSE.ttadec](./LICENSE.ttadec)
