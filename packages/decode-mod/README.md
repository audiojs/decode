# @audio/decode-mod

Decode tracker modules — MOD, XM, S3M, IT, MPTM, and everything else [libopenmpt](https://lib.openmpt.org/libopenmpt/) reads — to PCM float samples.<br>
[libopenmpt](https://github.com/OpenMPT/openmpt) compiled to a single-file WASM ES module — no side files, loads from any CDN, Node, workers and AudioWorklets.

[![npm install @audio/decode-mod](https://nodei.co/npm/@audio/decode-mod.png?mini=true)](https://npmjs.org/package/@audio/decode-mod/)

```js
import decode, { decoder, info } from '@audio/decode-mod'

let { channelData, sampleRate } = await decode(modBytes)

let meta = await info(modBytes)
// { title, artist, type, typeLong, tracker, message, duration, channels, patterns, orders, instruments, samples }
```

A tracker module is a small program (samples + patterns + a playback sequence), not raw
audio — libopenmpt is the mixer that renders it. Render params follow libopenmpt's public
C API (`libopenmpt/libopenmpt.h`): `openmpt_module_create_from_memory2`,
`openmpt_module_read_float_{mono,stereo,quad}`, `openmpt_module_set_render_param`. A
module is a whole file, not a stream — there's no meaningful partial parse of a truncated
MOD/XM/S3M/IT, so `decode()` always needs the complete file. `repeat_count` is fixed at 0
(play once); `duration` is a render-length cap for songs that loop or whose estimated
length is impractically long.

```js
let { channelData } = await decode(bytes, {
  sampleRate: 44100,
  channels: 1,           // mono / stereo / quad (L,R,RL,RR)
  duration: 30,           // seconds — cap for endless/looping songs
  interpolation: 2,       // 0 internal default, 1 hold, 2 linear, 4 cubic, 8 windowed sinc
  stereoSeparation: 150,  // percent, [0,200]
  gain: -6,                // dB
})
```

| Param | Default | |
|---|---|---|
| `sampleRate` | `48000` | Output sample rate, Hz |
| `channels` | `2` | `1` mono, `2` stereo, `4` quad (L,R,RL,RR) |
| `duration` | libopenmpt's estimate, capped at 600s | Seconds to render; hard cap for endless/looping songs |
| `interpolation` | `8` | `OPENMPT_MODULE_RENDER_INTERPOLATIONFILTER_LENGTH` — 0 internal default, 1 zero-order hold, 2 linear, 4 cubic, 8 windowed sinc (8 taps) |
| `stereoSeparation` | `100` | Percent, `[0,200]` |
| `gain` | — | Master gain, dB |

## API

### `decode(src: Uint8Array | ArrayBuffer, opts?): Promise<AudioData>`

Render a complete module.

### `info(src: Uint8Array | ArrayBuffer): Promise<ModuleInfo>`

Read title/artist/format/duration/channel-and-pattern counts without rendering audio.

### `decoder(opts?): Promise<ModDecoder>`

`{ decode(chunk), flush(), free() }`. `decode(chunk)` expects (and renders) a complete
file in one call — a module can't be parsed from a partial buffer. `flush()` returns
empty (nothing carries over); `free()` is a no-op (no WASM state outlives a single
`decode()` call). Matches [@audio/decode-qoa](../decode-qoa)'s whole-file shape.

### `AudioData`

```ts
{ channelData: Float32Array[], sampleRate: number }
```

## Notes

- MO3 (a separately-compressed OpenMPT container) is not supported: it needs either an
  external `unmo3` or the bundled minimp3/stb_vorbis/miniz fallback decoders, none of
  which ship here (see `build.sh`) to keep the WASM small.
- No volume-ramping/click suppression beyond libopenmpt's own mixer — that's libopenmpt's
  job, not this package's.
- Format reference: [ProTracker MOD](https://www.aes.id.au/modformat.html), [FastTracker II XM](https://github.com/milkytracker/MilkyTracker/blob/master/resources/reference/xm-form.txt), [Scream Tracker 3 S3M](https://www.romhacking.net/documents/[177]S3M%20Format.txt), [Impulse Tracker IT](https://github.com/schismtracker/schismtracker/wiki/ITTECH.TXT); libopenmpt's own [C API docs](https://lib.openmpt.org/doc/).

**Use when:** playing back tracker-format chiptunes/game music in the browser, or converting a `.mod`/`.xm`/`.s3m`/`.it` library to PCM/WAV in bulk.

---

Part of [@audio/decode](https://github.com/audiojs/decode) — the decode family umbrella.

## License

[ॐ](https://github.com/krishnized/license/) · [BSD-3-Clause](./LICENSE), same as the bundled [libopenmpt](./LICENSE.libopenmpt).
