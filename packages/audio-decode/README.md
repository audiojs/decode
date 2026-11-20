# audio-decode

> Decode any audio format to raw samples.

`audio-decode` is the unscoped alias of [`@audio/decode`](https://npmjs.org/package/@audio/decode). Both names contain the same code, and from 4.3.1 on each release comes out under both at one version: `audio-decode@x` depends on exactly `@audio/decode@x` and re-exports its entries (`audio-decode`, `audio-decode/stream`, `audio-decode/meta`; a codec by subpath is `@audio/decode/<codec>`). The scoped package is canonical and hosts the codec packages such as `@audio/decode-mp3` and `@audio/decode-flac`.

```js
import decode from 'audio-decode'
let { channelData, sampleRate } = await decode(buf)
```

Full docs: [@audio/decode](https://github.com/audiojs/decode). What changed in each version: [releases](https://github.com/audiojs/decode/releases).

## License

[ॐ](https://github.com/krishnized/license/) · [MIT](./LICENSE)
