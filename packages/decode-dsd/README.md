# @audio/decode-dsd [![npm](https://img.shields.io/npm/v/@audio/decode-dsd)](https://www.npmjs.com/package/@audio/decode-dsd) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

Decode DSD (DSF, DFF) audio to PCM float samples.

```
npm install @audio/decode-dsd
```

```js
import decode, { decoder } from '@audio/decode-dsd'
```

DSD is a 1-bit-per-sample sigma-delta stream running at 2.8224 MHz and up ("DSD64", "DSD128", …). Getting to PCM is a low-pass + decimate: a Kaiser-windowed-sinc FIR removes the noise-shaped quantization noise pushed above the audio band, then every Nth sample is kept. The first decimation stage (raw bits → 8× that rate) runs directly on the 1-bit stream using per-byte lookup tables — the classic trick from Sebastian Gesemann's [dsd2pcm](https://github.com/sdaau/dsd2pcm) (BSD), also used by ffmpeg's `dsd_lsbf_planar`/`dsd_msbf` decoders; this is an independent implementation of the same idea, not a port. A second, ordinary decimating FIR (on the now multi-bit float stream, much cheaper) reaches 44.1/88.2/176.4 kHz.

```js
let { channelData, sampleRate } = decode(dsfOrDffBytes)

let dec = decoder({ sampleRate: 88200 })
let head = dec.decode(chunk1)   // synchronous; partial blocks carry over
let tail = dec.flush()
dec.free()
```

Both `decode()` and `decoder()` are synchronous — no WASM, no async setup.

## Formats

**DSF** (Sony DSD Stream File): `DSD `/`fmt `/`data` chunks, up to 5.1 channels, DSD64/128/256/512 sample rates, 1-bit LSB-first or MSB-first packing (per the `fmt` chunk's `bitsPerSample` field, exactly as the [spec](https://dsd-guide.com/sonys-dsf-file-format-spec) defines it), data interleaved in fixed 4096-byte-per-channel blocks. Trailing ID3v2 tag (pointed to by the `DSD ` chunk header) via `@audio/decode-dsd/meta`.

**DFF** (Philips DSDIFF): `FRM8`/`FVER`/`PROP` (`FS`, `CHNL`, `CMPR`)/`DSD ` chunks, data interleaved byte-per-channel, always MSB-first. DST-compressed files (`CMPR` = `'DST '`) throw `Unsupported: DST` — DST is a separate lossless codec, not raw DSD. Edited-master chunks (`DIIN`/`DITI`/…) are ignored. A non-standard `ID3 ` chunk, if present, is also readable via `@audio/decode-dsd/meta`.

## API

### `decode(src, opts?): AudioData`

Decode a complete `Uint8Array` or `ArrayBuffer`.

### `decoder(opts?): DSDDecoder`

- `dec.decode(data)`: decode a chunk. DSF needs a full `4096 × channels`-byte block group per channel before it can decode anything (that's the container's own interleave unit); DFF only needs one `channels`-byte frame.
- `dec.flush()`: zero-pads a short final block to the container's own frame size (matching the DSF spec's own convention for a partial last block) and decodes it — it does not separately drain the FIR's group-delay tail.
- `dec.free()`: release state. Idempotent.

| Option | Default | |
|---|---|---|
| `sampleRate` | `dsdRate / 32` | Output rate. Must equal `dsdRate / 8`, `/16`, `/32`, or `/64` (DSD64 → 352.8k / 176.4k / 88.2k / 44.1k) — the byte-lookup-table stage only decimates in whole-byte (8-bit) steps. |
| `cutoff` | `0.45` | Passband edge, as a fraction of the output rate, for whichever stage sets the final rate. |
| `length` | computed | FIR taps for that stage. Longer = closer to the `stopband` target, slower. |
| `stopband` | `100` | Target stopband attenuation (dB), used to derive the Kaiser β. |

`AudioData` is `{ channelData: Float32Array[], sampleRate: number }`.

DSD's 1-bit ±1 maps directly to PCM full scale — no gain change is applied. SACD material mastered at DSD's nominal "0 dB" can legitimately hit +6 dB relative to PCM full scale; this decoder does not clamp or renormalize, so such material will clip in the Float32 sense (values outside ±1) exactly as it would on any other bit-transparent DSD decoder.

## Numbers

- Bit-domain stage 1 (fixed): 192 taps (96-tap half + symmetry, 12-byte lookup tables), cutoff 0.45×(dsdRate/8), 100 dB target stopband.
- Stage 2 (built per request): length computed from the Kaiser formula for a truly alias-free transition band (passband edge to the decimation's own mirror point) at the requested `stopband`.
- Measured (2nd-order test tone through a properly-synthesized 5th-order 1-bit modulator, `test.js`): in-band SNR 114–117 dB at 44.1k/88.2k/176.4k (≥ 80 dB required, conservative under the modulator's own ~100+ dB theoretical ceiling — see `test.js` for the exact citation).
- Cross-checked against `ffmpeg -i x.dsf -f f32le -ar 88200 -`: 1 kHz tone amplitude within 0.000 dB, phase within 1.6° after delay alignment, duration exact.
- Speed: 60 s stereo DSD64 → 88.2 kHz decodes in ≈ 2.1 s (pure JS, single core).

## License

[ॐ](https://github.com/krishnized/license/) · [MIT](./LICENSE)

**Use when:** you have raw DSD/SACD-rip material (`.dsf`/`.dff`) and need PCM — playback, format conversion, or feeding a conventional DSP chain. Not a DST decoder (DST-compressed DFF throws) and not a DSD *encoder*.

---

Part of [@audio/decode](https://github.com/audiojs/decode) — the decode family umbrella.

MIT © [audiojs](https://github.com/audiojs)
