import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(path.resolve(__dirname, 'closeops-actions.ts'), 'utf8')

describe('brief approve vs CYS', () => {
  it('approveBriefAction does not write CysReadiness.approvedAt', () => {
    const fn = src.split('export async function approveBriefAction')[1]?.split('export async function')[0] ?? ''
    expect(fn).toContain('content.approved = true')
    expect(fn).not.toMatch(/cysReadiness/i)
    expect(fn).not.toContain('approvedAt')
  })

  it('editBriefAction does not send CYS', () => {
    const fn = src.split('export async function editBriefAction')[1] ?? ''
    expect(fn).not.toMatch(/cysReadiness/i)
    expect(fn).not.toMatch(/generateCysPackage/)
  })
})
