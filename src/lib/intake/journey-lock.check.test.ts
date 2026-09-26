import { execSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const PHRASE = 'JOURNEY LOCK OPEN'
const TRAILER = `Journey-Change-Approval: ${PHRASE}`
const PROTECTED = [
  'src/lib/intake/scs-analysis.ts',
  'src/lib/intake/scs-document-requirements.ts',
  'src/lib/intake/client-journey.check.test.ts',
  'src/lib/intake/journey-lock.check.test.ts',
  'src/lib/case-facts.ts',
  'src/lib/packet/data.ts',
  'src/lib/packet/call-sheet.ts',
  'src/lib/daily-desk-finance.ts',
]

function sh(command: string): string {
  return execSync(command, { encoding: 'utf8' }).trim()
}

function locked(file: string): boolean {
  return PROTECTED.includes(file)
}

describe('client-journey flow lock', () => {
  it('denies a flow change that lacks the typed approval line', () => {
    let from = ''
    try { from = sh('git merge-base HEAD origin/main') } catch { return }
    const changed = sh(`git diff --name-only ${from}`).split('\n').filter(locked)
    if (!changed.length) return
    const dirty = new Set([
      ...sh('git diff --name-only').split('\n'),
      ...sh('git diff --cached --name-only').split('\n'),
    ].filter(Boolean))
    const denied: string[] = []
    for (const file of changed) {
      if (dirty.has(file)) {
        denied.push(`${file} is changed and not committed`)
        continue
      }
      const commits = sh(`git log ${from}..HEAD --format=%H -- ${file}`).split('\n').filter(Boolean)
      for (const commit of commits) {
        const body = sh(`git log -1 --format=%B ${commit}`)
        if (!body.includes(TRAILER)) denied.push(`${file} in ${commit.slice(0, 8)}`)
      }
    }
    expect(denied, `Type this exact line into the commit: ${TRAILER}`).toEqual([])
  })
})
