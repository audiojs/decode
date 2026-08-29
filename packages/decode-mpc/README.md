# @audio/decode-mpc

Decode Musepack (MPC) to PCM float samples.<br>
[libmpcdec](https://svn.musepack.net/libmpc/) (mirrored at [evpobr/libmpc](https://github.com/evpobr/libmpc)) compiled to a single-file WASM ES module — no side files, loads from any CDN, Node, workers and AudioWorklets.

[![npm install @audio/decode-mpc](https://nodei.co/npm/@audio/decode-mpc.png?mini=true)](https://npmjs.org/package/@audio/decode-mpc/)

```js
import decode, { decoder } from '@audio/decode-mpc'

let { channelData, sampleRate } = await decode(mpcBytes)

let dec = await decoder()
let head = dec.decode(chunk1)   // synchronous; returns whatever the bytes seen so far allow
let tail = dec.flush()
dec.free()
```

Decodes both stream generations: SV7 (`MP+` magic, 1999–2006 era encoders) and SV8 (`MPCK` magic, current). The demuxer (container framing, APEv2/ID3v1 tags, seek tables) runs inside libmpcdec itself; this package only feeds it bytes. Mono or stereo, whatever the stream declares. Built with `MPC_FIXED_POINT` off, so libmpcdec hands back native float samples — no fixed-point requantization step.

## API

### `decode(src: Uint8Array | ArrayBuffer): Promise<AudioData>`

Decode a complete stream. Throws if the input never parses as Musepack (no `MP+`/`MPCK` magic, or a header that still won't parse after a generous budget).

### `decoder(): Promise<MpcDecoder>`

Streaming decoder: `decode(chunk)` returns the samples of every complete frame the data seen so far allows, `flush()` decodes anything a safety margin was withholding at the true end of stream, `free()` releases WASM memory. `errors` counts frames abandoned after a bitstream desync (see Streaming below — this stops the decoder, it does not resync and skip).

### `AudioData`

```ts
{ channelData: Float32Array[], sampleRate: number }
```

## Streaming

`decode(chunk)` feeds bytes into a growable buffer inside WASM and retries `mpc_demux_init()` on every call until the header parses — libmpcdec's `mpc_reader` callback interface has no "not enough data yet" signal distinct from "end of stream," and a frame decode that runs out of buffered bytes mid-frame leaves the bitstream position permanently desynced (no retry). So frames are only decoded once at least 4352 bytes (`MAX_FRAME_SIZE`, libmpcdec's own worst-case compressed frame size) are buffered ahead of the reader's cursor — safe for any chunk size, including 1 byte at a time.

What that means in practice differs by version:

- **SV7** streams genuinely progressively. Its header is a fixed ~30 bytes with no forward references, so `decoder()` starts emitting frames as soon as the first chunk carries that much.
- **SV8** streams keep their seek table near the end of the file — `mpcenc` can only patch the header's pointer to it once encoding finishes and the final byte offset is known — and libmpcdec reads that table during `mpc_demux_init()`. In practice an SV8 `decoder()` buffers (close to) the whole stream before the first frame comes out. `decode(chunk)` never blocks or throws while this is happening; it just returns nothing until the header resolves.

Either way the input buffer is never discarded (the SV8 seek-table read can jump backward to any earlier offset), so streaming does not save memory for SV8 — only latency-to-first-decode for SV7.

## Measured

- 50,773 bytes WASM (libmpcdec `7d04739`, `-Oz -flto`, single-file ES module).
- ~86–89 dB SNR vs `ffmpeg -i x.mpc -f f32le -` on SV8 fixtures generated with `mpcenc`; 57–58 dB on an independent SV7 sample from the FFmpeg FATE suite (own encode vs. own decode of the exact same bits, so the higher SV8 number just reflects less inter-decoder disagreement, not different codec fidelity).
- ~1250× realtime (a 0.5 s clip decodes in ~0.4 ms; a 5.8 s clip in ~4.6 ms; Apple M-series, Node 25).

## License

[ॐ](https://github.com/krishnized/license/) · [BSD-3-Clause](./LICENSE), matching the bundled [libmpcdec](./LICENSE.libmpcdec).

---

Part of [@audio/decode](https://github.com/audiojs/decode) — the decode family umbrella.
