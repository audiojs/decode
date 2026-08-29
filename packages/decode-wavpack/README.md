# @audio/decode-wavpack [![npm](https://img.shields.io/npm/v/@audio/decode-wavpack)](https://www.npmjs.com/package/@audio/decode-wavpack) [![BSD-3-Clause](https://img.shields.io/badge/BSD--3--Clause-%E0%A5%90-white)](https://github.com/krishnized/license)

Decode WavPack (.wv) to PCM float samples

```
npm install @audio/decode-wavpack
```

```js
import decode, { decoder } from '@audio/decode-wavpack'
```

[libwavpack](https://github.com/dbry/WavPack) (the reference WavPack 5 implementation, David Bryant) compiled to a single-file WASM ES module — no side files, loads from any CDN, Node, workers and AudioWorklets. Handles everything the format defines: lossless and hybrid/lossy, 8/16/24/32-bit integer and 32-bit float, mono through multichannel, and DSD-as-PCM (`OPEN_DSD_AS_PCM`, decimated to 24-bit PCM by the library). Streaming decode drives libwavpack's own block reader through a memory-backed `WavpackStreamReader64`, so multichannel block groups and adaptive decorrelation state are handled exactly as the reference library handles them — this package only tracks byte-level block boundaries.

```js
let { channelData, sampleRate } = await decode(wvBytes)

let dec = await decoder()
let head = dec.decode(chunk1)   // synchronous; partial blocks carry over
let tail = dec.flush()          // drops an incomplete trailing block, if any
dec.free()
```

| Export | | |
|---|---|---|
| `decode(src)` | `Promise<AudioData>` | Whole-stream decode |
| `decoder()` | `Promise<{decode, flush, free}>` | Streaming decoder; `decode(chunk)` is synchronous |

`AudioData` is `{ channelData: Float32Array[], sampleRate: number }`, samples in `[-1, 1]`. Integer PCM is scaled by `2^(bits-1)` (asymmetric, matching WAV convention: max positive sample maps to `<1`, max negative to exactly `-1`); float PCM is a direct bit reinterpretation (WavPack stores float samples pre-normalized when opened with `OPEN_NORMALIZE`, which this package always sets). Channels come out in the order libwavpack reports them, which for standard Microsoft-ordered sources (anything ffmpeg or the WavPack CLI produces) is WAV order: FL, FR, FC, LFE, BL, BR, ...

`decode()` drains every sample libwavpack can produce from the blocks fed so far, every call — there's no encoder lookahead or block-spanning delay to hold back, so `flush()` only ever discards an incomplete trailing block (a stream cut off mid-block) and returns nothing new.

Hybrid/lossy WavPack (`-b<n>`) decodes at whatever quality it was encoded at; the `.wvc` correction file (lossless-hybrid two-file mode) is not read — only the standalone `.wv` bitstream. A garbage or non-WavPack input throws instead of returning empty/wrong data.

**Use when:** you need a from-scratch, spec-accurate WavPack decoder in the browser or Node — audio tools reading `.wv` files, WavPack-in-container demuxers, or any pipeline that already speaks `@audio`'s `{channelData, sampleRate}` shape.

---

Part of [@audio/decode](https://github.com/audiojs/decode) — the decode family umbrella.

[ॐ](https://github.com/krishnized/license/) · [BSD-3-Clause](./LICENSE), inherited from the bundled [libwavpack](./LICENSE.wavpack).
