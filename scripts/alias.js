// audio-decode, the unscoped alias: packages/audio-decode's re-exports of @audio/decode, published at the umbrella's
// own version and depending on exactly it, so the two names cannot part. package.json's postpublish runs this once the
// umbrella is out; `node scripts/alias.js` alone publishes the alias where the registry lacks it.
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const root = join(import.meta.dirname, '..'), json = f => JSON.parse(readFileSync(f, 'utf8'))

// the alias as it is published, in a folder of its own: packages/audio-decode, its manifest given the umbrella's
// version and the umbrella at that version as its one dependency → { dir, manifest }
export function alias() {
  const pkg = json(join(root, 'package.json')), dir = mkdtempSync(join(tmpdir(), 'audio-decode-'))
  cpSync(join(root, 'packages/audio-decode'), dir, { recursive: true })
  const { name, ...rest } = json(join(dir, 'package.json')), manifest = { name, version: pkg.version, ...rest, dependencies: { [pkg.name]: pkg.version } }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { dir, manifest }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { dir, manifest: { name, version } } = alias(), id = `${name}@${version}`
  let out = ''
  try { out = execFileSync('npm', ['view', id, 'version'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch {}
  if (out === version) console.log(`skip ${id}`)
  // a dry run of the umbrella's publish is a dry run of this one
  else execFileSync('npm', ['publish', ...(process.env.npm_config_dry_run === 'true' ? ['--dry-run'] : [])], { cwd: dir, stdio: 'inherit' })
}
