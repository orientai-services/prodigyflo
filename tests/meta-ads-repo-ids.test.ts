/**
 * Repo canary (docs/META_ADS_SCS.md §3.10):
 *  - the only real-looking ad account ids anywhere under src, docs, tests, tools
 *    and scripts are SCS General 1 and the test-only fake foreign account;
 *  - the public route surface under /api/meta and /api/jobs is pinned (both
 *    prefixes are public in proxy.ts, so a new route there needs a review).
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const ALLOWED_IDS = new Set(['act_1742876583597558', 'act_999000111222333'])
const SKIP = new Set(['node_modules', '.next', '.git'])
const EXT = /\.(ts|tsx|js|mjs|cjs|json|md|sql|prisma|txt|yml|yaml)$/i

function walk(dir: string, out: string[] = []): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    if (SKIP.has(name)) continue
    const p = path.join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (EXT.test(name) && st.size < 2_000_000) out.push(p)
  }
  return out
}

describe('repo canary', () => {
  it('no other act_ ad account id appears in the repo', () => {
    const offenders: string[] = []
    for (const top of ['src', 'docs', 'tests', 'tools', 'scripts', 'prisma']) {
      for (const file of walk(path.join(ROOT, top))) {
        const text = readFileSync(file, 'utf8')
        for (const m of text.matchAll(/act_\d{15,16}\b/g)) {
          if (!ALLOWED_IDS.has(m[0])) offenders.push(`${path.relative(ROOT, file)}: ${m[0].slice(0, 7)}…`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the route files under /api/meta and /api/jobs are pinned', () => {
    const routes = [
      ...walk(path.join(ROOT, 'src/app/api/meta')),
      ...walk(path.join(ROOT, 'src/app/api/jobs')),
    ]
      .filter((f) => /route\.(ts|tsx)$/.test(f))
      .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'))
      .sort()
    expect(routes).toEqual([
      'src/app/api/jobs/meta-sync/route.ts',
      'src/app/api/jobs/run/route.ts',
      'src/app/api/meta/instagram/route.ts',
      'src/app/api/meta/leads/route.ts',
    ])
  })
})
