// Re-exports each member by subpath: @audio/<u>/<x>[/<sub>] ≡ @audio/<u>-<x>[/<sub>], one line in members/.
// node scripts/members.js writes them; --check fails where they differ from the members' exports.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'fs'
import { join, dirname, relative } from 'path'

const root = join(import.meta.dirname, '..'), out = join(root, 'members'), check = process.argv.includes('--check')
const json = f => JSON.parse(readFileSync(f, 'utf8'))
const target = e => typeof e === 'string' ? e : e && (e.import ?? e.node ?? e.default ?? target(e.browser))
const pkg = json(join(root, 'package.json')), cat = pkg.name.split('/')[1]
const local = new Map(readdirSync(join(root, 'packages')).filter(d => existsSync(join(root, 'packages', d, 'package.json')))
  .map(d => [json(join(root, 'packages', d, 'package.json')).name, join(root, 'packages', d)]))

// path → body, for each subpath each member exports
const want = new Map()
for (const name of Object.keys(pkg.dependencies ?? {}).filter(n => local.has(n) && n.startsWith(`@audio/${cat}-`))) {
  const dir = local.get(name), m = json(join(dir, 'package.json')), x = name.slice(`@audio/${cat}-`.length)
  const ex = m.exports && typeof m.exports === 'object' && Object.keys(m.exports)[0]?.startsWith('.') ? m.exports : { '.': m.exports ?? m.main ?? './index.js' }
  for (const [k, v] of Object.entries(ex)) {
    if (k === './package.json' || k.includes('*')) continue
    const spec = name + k.slice(1), path = x + k.slice(1), file = target(v)
    if (want.has(path)) throw new Error(`two members at ./${path}`)
    const def = file && /export\s+default\b|\bas\s+default\b|[{,]\s*default\s*[},]/.test(readFileSync(join(dir, file), 'utf8'))
    want.set(path, `export * from '${spec}'\n` + (def ? `export { default } from '${spec}'\n` : ''))
  }
}

if (check) {
  const have = d => existsSync(d) ? readdirSync(d, { recursive: true }).map(f => join(d, f)).filter(f => f.endsWith('.js')) : []
  const stale = [...want].filter(([p, b]) => !existsSync(join(out, p + '.js')) || readFileSync(join(out, p + '.js'), 'utf8') !== b).map(([p]) => p)
  const extra = have(out).map(f => relative(out, f).slice(0, -3)).filter(p => !want.has(p))
  if (stale.length || extra.length) { console.error(`members/ out of date (npm run members): ${[...stale, ...extra].join(', ')}`); process.exit(1) }
} else {
  rmSync(out, { recursive: true, force: true })
  for (const [p, b] of want) {
    mkdirSync(dirname(join(out, p)), { recursive: true })
    writeFileSync(join(out, p + '.js'), b)
    writeFileSync(join(out, p + '.d.ts'), b)
  }
  console.log(`${pkg.name}: ${want.size} subpaths`)
}
