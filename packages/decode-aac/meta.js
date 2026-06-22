/**
 * M4A / MP4 metadata — iTunes-style ilst tags + cover art.
 * @module @audio/decode-aac/meta
 *
 * import { parseMeta } from '@audio/decode-aac/meta'
 * let { meta, sampleRate } = parseMeta(m4aBytes)
 * // meta: { title, artist, album, year, genre, track, ..., pictures, raw }
 */

const TD = new TextDecoder('utf-8')
const C = String.fromCharCode(0xA9) // © prefix used by iTunes text atoms

function r32(b, o) { return (b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3] }
function r16(b, o) { return (b[o] << 8) | b[o + 1] }
function typ(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) }

const ILST_MAP = {
  [C + 'nam']: 'title', [C + 'ART']: 'artist', aART: 'albumartist', [C + 'alb']: 'album',
  [C + 'day']: 'year', [C + 'gen']: 'genre', [C + 'wrt']: 'composer', [C + 'cmt']: 'comment',
  [C + 'too']: 'software', cprt: 'copyright', [C + 'lyr']: 'lyrics'
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'meta'])

function applyTag(name, flags, payload, meta, pictures) {
  if (name === 'covr') {
    let mime = flags === 14 ? 'image/png' : flags === 13 ? 'image/jpeg' : 'application/octet-stream'
    pictures.push({ mime, type: 3, description: '', data: payload.slice() })
    return
  }
  if (name === 'trkn') { if (payload.length >= 4) meta.track = String(r16(payload, 2)); return }
  if (name === 'disk') { if (payload.length >= 4) meta.disc = String(r16(payload, 2)); return }
  if (name === 'tmpo') { if (payload.length >= 2) meta.bpm = String(r16(payload, 0)); return }
  let key = ILST_MAP[name]
  if (key && meta[key] == null) meta[key] = TD.decode(payload).replace(/\0+$/, '')
}

// ilst children are tag atoms; each holds a 'data' sub-atom: type(4) + flags(4) + reserved(4) + value
function parseIlst(b, start, end, meta, pictures) {
  let off = start
  while (off + 8 <= end) {
    let size = r32(b, off); if (size < 8) break
    let name = typ(b, off + 4), aEnd = Math.min(off + size, end), p = off + 8
    while (p + 16 <= aEnd) {
      let dsize = r32(b, p); if (dsize < 16) break
      if (typ(b, p + 4) === 'data') {
        let flags = r32(b, p + 8) & 0xFFFFFF
        applyTag(name, flags, b.subarray(p + 16, Math.min(p + dsize, aEnd)), meta, pictures)
        break
      }
      p += dsize
    }
    off += size
  }
}

function walk(b, start, end, ctx) {
  let off = start
  while (off + 8 <= end) {
    let size = r32(b, off), type = typ(b, off + 4)
    if (size === 0) size = end - off
    else if (size === 1) break // 64-bit box — not expected in moov metadata
    if (size < 8 || off + size > end) break
    let bodyOff = off + 8
    if (type === 'ilst') parseIlst(b, bodyOff, off + size, ctx.meta, ctx.pictures)
    else if (type === 'stsd') walk(b, bodyOff + 8, off + size, ctx) // FullBox(4) + entryCount(4)
    else if ((type === 'mp4a' || type === 'alac') && !ctx.sampleRate) ctx.sampleRate = r16(b, bodyOff + 24)
    else if (CONTAINERS.has(type)) walk(b, bodyOff + (type === 'meta' ? 4 : 0), off + size, ctx)
    off += size
  }
}

/** Parse M4A/MP4 metadata. Returns { meta, sampleRate, markers, regions } or null. */
export function parseMeta(bytes) {
  let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (b.length < 8 || typ(b, 4) !== 'ftyp') return null
  let ctx = { meta: {}, pictures: [], sampleRate: 0 }
  walk(b, 0, b.length, ctx)
  ctx.meta.pictures = ctx.pictures
  return { meta: ctx.meta, sampleRate: ctx.sampleRate, markers: [], regions: [] }
}
