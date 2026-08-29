# @audio/decode-ape

Decode Monkey's Audio (APE) to PCM float samples.<br>
FFmpeg's `ape` decoder — a slim LGPL-2.1-or-later `libavcodec`/`libavutil` build (no GPL components) — compiled to a single-file WASM ES module. No side files, loads from any CDN, Node, workers and AudioWorklets.

[![npm install @audio/decode-ape](https://nodei.co/npm/@audio/decode-ape.png?mini=true)](https://npmjs.org/package/@audio/decode-ape/)

```js
import decode, { decoder } from '@audio/decode-ape'

let { channelData, sampleRate } = await decode(apeBytes)

let dec = await decoder()
let head = dec.decode(chunk1)   // synchronous; EMPTY until the header + seek table are complete
let tail = dec.flush()          // decodes the final frame — its length isn't known until here
dec.free()
```

Monkey's Audio (`.ape`) is a lossless predictive codec — [monkeysaudio.com](https://monkeysaudio.com), file versions 3.80 through 3.99. FFmpeg ships no APE *demuxer* library to link against (only the format-agnostic `libavformat`, which this build excludes), so the container — descriptor/header block, seek table, per-frame packet layout — is parsed here in JS, replicating `libavformat/ape.c`'s `ape_read_header`/`ape_read_packet` exactly (field layout, skip/size arithmetic, the `[nblocks, skip, data]` packet shape `apedec.c` expects); decoding itself is FFmpeg's own `ape` decoder. Mono or stereo, 8/16/24-bit, any compression level (fast/normal/high/extra high/insane) — the decoder rejects anything else (`avcodec/apedec.c` only supports ≤ 2 channels and those three bit depths).

Frame boundaries come entirely from the header's seek table, so `decoder()` decodes each frame as soon as its bytes are fully buffered — no need to wait for a container-level end marker. The one exception is the **last** frame: its byte length isn't in the seek table (only the *next* frame's position bounds a frame, and there is no next for the last one) — FFmpeg's demuxer derives it from the total file size once known, so this decoder does the same at `flush()`, using the total byte count fed to it as that "file size". A stream that ends mid-frame (truncated source) still decodes whatever's decodable — matching `libavformat`'s own short-read tolerance (`ape_read_packet`'s `avio_read` can return fewer bytes than requested; the decoder just decodes less).

## API

### `decode(src: Uint8Array | ArrayBuffer): Promise<AudioData>`

Decode a complete `.ape` file.

### `decoder(): Promise<APEDecoder>`

Synchronous streaming decoder: `decode(chunk)` returns every frame's samples once its bytes are buffered (`EMPTY` while the header/seek table or a frame's data is still incomplete), `flush()` decodes the final frame, `free()` releases WASM memory. `errors` counts frames that failed to decode.

### `AudioData`

```ts
{ channelData: Float32Array[], sampleRate: number }
```

**Use when:** you need to play or transcode `.ape` files in the browser or Node without shelling out to `ffmpeg`/`mac`.

## Fixtures

Test fixtures at [1000, 2000, 3000, 4000, 5000] compression, mono, 24-bit and 8-bit were generated with the [Monkey's Audio SDK](https://monkeysaudio.com/developers.html) reference `mac` CLI (Monkey's Audio Source Code License — used only to produce test data, nothing from the SDK is ported or shipped) and checked **bit-exact** against `ffmpeg -i x.ape -f s16le/s32le/u8 -`. Three additional fixtures are real files from FFmpeg's own FATE test suite (`rsync://samples.ffmpeg.org/fate-suite/lossless-audio/`) — needed because the reference encoder here only produces the modern (≥ 3.98) header; the FATE samples cover the legacy 3.80/3.94 header format and short-read/truncation handling.

## License

[ॐ](https://github.com/krishnized/license/) · [LGPL-2.1-or-later](./LICENSE), inherited from the bundled [FFmpeg](https://ffmpeg.org/legal.html) `ape` decoder (built without `--enable-gpl` — see [`build.sh`](./build.sh) and [`LICENSE.ffmpeg`](./LICENSE.ffmpeg)). FFmpeg source: the shared [`lib/ffmpeg`](../../lib/ffmpeg) submodule (`release/7.1`), also used by [`@audio/decode-eac3`](../decode-eac3).
