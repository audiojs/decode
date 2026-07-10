# audio-decode

> Decode audio (wav, mp3, flac, ogg, opus, aac, qoa, aiff, caf, webm, amr, wma) to AudioBuffer.

`audio-decode` is the unscoped alias of [`@audio/decode`](https://npmjs.org/package/@audio/decode) — same code, same releases. Both names are maintained; the scope is canonical and hosts the per-codec atoms (`@audio/decode-mp3`, `@audio/decode-flac`, …).

```js
import decode from 'audio-decode'
let audioBuffer = await decode(buf)
```

Full docs: [@audio/decode](https://github.com/audiojs/decode).
