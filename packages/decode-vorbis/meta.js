/**
 * Ogg Vorbis metadata — Vorbis comment tags + cover art.
 * @module @audio/decode-vorbis/meta
 *
 * import { parseMeta } from '@audio/decode-vorbis/meta'
 * let { meta, sampleRate } = parseMeta(oggBytes)
 * // meta: { title, artist, album, year, genre, ..., pictures, raw }
 */

const TD = new TextDecoder('utf-8'), TD_L1 = new TextDecoder('iso-8859-1')

const VORBIS_MAP = {
  TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumartist',
  COMPOSER: 'composer', GENRE: 'genre', DATE: 'year', TRACKNUMBER: 'track',
  DISCNUMBER: 'disc', BPM: 'bpm', KEY: 'key', COMMENT: 'comment', DESCRIPTION: 'comment',
  COPYRIGHT: 'copyright', ISRC: 'isrc', PUBLISHER: 'publisher', ENCODER: 'software',
  LYRICS: 'lyrics'
}

function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 0x1000000)) >>> 0 }
function u32be(b, o) { return (b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3] }

function concat(arr) {
  if (arr.length === 1) return arr[0]
  let n = 0; for (let a of arr) n += a.length
  let out = new Uint8Array(n), o = 0
  for (let a of arr) { out.set(a, o); o += a.length }
  return out
}

// Reassemble logical packets from the leading Ogg pages (enough for the header packets).
function oggPackets(b, max) {
  let packets = [], seg = [], off = 0
  while (off + 27 <= b.length && packets.length < max) {
    if (b[off] !== 0x4f || b[off + 1] !== 0x67 || b[off + 2] !== 0x67 || b[off + 3] !== 0x53) break // 'OggS'
    let nseg = b[off + 26], tbl = off + 27, body = tbl + nseg
    if (body > b.length) break
    let size = 0
    for (let i = 0; i < nseg; i++) size += b[tbl + i]
    let p = body
    for (let i = 0; i < nseg; i++) {
      let lace = b[tbl + i]
      seg.push(b.subarray(p, p + lace)); p += lace
      if (lace < 255) { packets.push(concat(seg)); seg = []; if (packets.length >= max) break }
    }
    off = body + size
  }
  return packets
}

function decodeB64(s) {
  if (typeof atob === 'function') { let bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }
  return Uint8Array.from(Buffer.from(s, 'base64'))
}

// FLAC PICTURE block layout (also used by METADATA_BLOCK_PICTURE)
function parsePicture(b) {
  let type = u32be(b, 0), o = 4
  let ml = u32be(b, o); o += 4
  let mime = TD_L1.decode(b.subarray(o, o + ml)); o += ml
  let dl = u32be(b, o); o += 4
  let desc = TD.decode(b.subarray(o, o + dl)); o += dl
  o += 16 // width, height, depth, colors
  let len = u32be(b, o); o += 4
  return { mime, type, description: desc, data: b.slice(o, o + len) }
}

// Vorbis comment block: vendor string + key=value list. Returns { tags, pictures, vendor }.
export function parseComment(b) {
  let off = 0, tags = {}, pictures = []
  let vlen = u32le(b, off); off += 4
  let vendor = TD.decode(b.subarray(off, off + vlen)); off += vlen
  let n = u32le(b, off); off += 4
  for (let i = 0; i < n && off + 4 <= b.length; i++) {
    let len = u32le(b, off); off += 4
    let s = TD.decode(b.subarray(off, off + len)); off += len
    let eq = s.indexOf('='); if (eq < 0) continue
    let key = s.slice(0, eq).toUpperCase(), val = s.slice(eq + 1)
    if (key === 'METADATA_BLOCK_PICTURE') { try { pictures.push(parsePicture(decodeB64(val))) } catch {} continue }
    let norm = VORBIS_MAP[key]
    if (norm && tags[norm] == null) tags[norm] = val
  }
  return { tags, pictures, vendor }
}

/** Parse Ogg Vorbis metadata. Returns { meta, sampleRate, markers, regions } or null. */
export function parseMeta(bytes) {
  let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (b.length < 4 || b[0] !== 0x4f || b[1] !== 0x67 || b[2] !== 0x67 || b[3] !== 0x53) return null
  let [id, comment] = oggPackets(b, 2)
  // identification header: 0x01 'vorbis' + version(4) + channels(1) + sampleRate(4 LE)
  if (!id || id.length < 16 || id[0] !== 1 || String.fromCharCode(id[1], id[2], id[3], id[4], id[5], id[6]) !== 'vorbis') return null
  let sampleRate = u32le(id, 12)
  let meta = {}, pictures = []
  // comment header: 0x03 'vorbis' then the comment block
  if (comment && comment.length > 7 && comment[0] === 3) {
    let { tags, pictures: pics, vendor } = parseComment(comment.subarray(7))
    Object.assign(meta, tags); pictures = pics; meta.raw = { vendor }
  }
  meta.pictures = pictures
  return { meta, sampleRate, markers: [], regions: [] }
}
