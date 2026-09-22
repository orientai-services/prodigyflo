import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const src = readFileSync(new URL('./apply.ts', import.meta.url), 'utf8')

describe('SCS webhook document kick', () => {
  it('starts this client’s file copy and analysis after processInbound commits', () => {
    expect(src).toMatch(/if\(result\.submission\.clientId&&source\.slug==='scs-website'\)/)
    expect(src).toMatch(/runPendingScsDocumentImports\(5, undefined, clientId\)/)
    expect(src).toMatch(/runPendingScsDocumentExtractions\(5, clientId\)/)
    expect(src).toMatch(/GET \/api\/jobs\/run remains the retry/)
  })

  it('does not copy files or run AI inside the intake lock', () => {
    const locked = src.slice(src.indexOf('async function processInboundLocked'), src.indexOf('export async function reapplySubmission'))
    expect(locked).not.toMatch(/runPendingScsDocumentImports/)
    expect(locked).not.toMatch(/runPendingScsDocumentExtractions/)
    expect(locked).toMatch(/No network, document copy or AI runs while the lock is held/)
  })
})
