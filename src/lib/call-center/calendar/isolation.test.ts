import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The Call Center Calendar is fully separate from the Master Calendar.
 * 1. No calendar code imports or references Master Calendar models or files.
 * 2. This branch leaves the Master Calendar models and files untouched vs main.
 */
const ROOT = path.resolve(__dirname, '../../../..')
const CALENDAR_DIRS = ['src/lib/call-center/calendar', 'src/components/call-center/calendar']
const SELF = path.relative(ROOT, __filename)

const FORBIDDEN = [
  /\bappointmentReceipt\b/i,
  /\bavailabilitySlot\b/i,
  /\bappointment\b/i,
  /lib\/scheduling/,
  /desk-calendar/,
]

function files(dir: string): string[] {
  const abs = path.join(ROOT, dir)
  return readdirSync(abs).flatMap((name) => {
    const p = path.join(abs, name)
    return statSync(p).isDirectory() ? files(path.join(dir, name)) : [path.join(dir, name)]
  })
}

describe('call center calendar isolation', () => {
  it('never imports or references Master Calendar models or files', () => {
    const hits: string[] = []
    for (const dir of CALENDAR_DIRS)
      for (const f of files(dir)) {
        if (f === SELF) continue
        const text = readFileSync(path.join(ROOT, f), 'utf8')
        for (const re of FORBIDDEN) if (re.test(text)) hits.push(`${f}: ${re}`)
      }
    expect(hits).toEqual([])
  })

  it('leaves Master Calendar files and schema models untouched vs main', () => {
    let base: string
    try {
      base = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: ROOT, encoding: 'utf8' }).trim()
    } catch {
      // Shallow or detached checkout without origin/main: nothing to compare.
      return
    }
    const diff = execFileSync(
      'git',
      ['diff', '--name-only', base, '--', 'src/lib/scheduling.ts', 'src/components/board/desk-calendar.tsx', 'src/app/(app)/board/desk-calendar.tsx'],
      { cwd: ROOT, encoding: 'utf8' },
    ).trim()
    expect(diff).toBe('')

    const block = (schema: string, model: string) => schema.match(new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? null
    const before = execFileSync('git', ['show', `${base}:prisma/schema.prisma`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
    const after = readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8')
    for (const model of ['Appointment', 'AppointmentReceipt', 'AvailabilitySlot']) {
      expect(block(after, model), model).toBe(block(before, model))
    }
  })

  it('the new migration only adds (no ALTER/DROP on existing tables)', () => {
    const dir = path.join(ROOT, 'prisma/migrations')
    const mine = readdirSync(dir).filter((d) => d.endsWith('_call_center_calendar'))
    expect(mine.length).toBe(1)
    const sql = readFileSync(path.join(dir, mine[0], 'migration.sql'), 'utf8')
    expect(sql).not.toMatch(/\bDROP\b/i)
    for (const m of sql.matchAll(/ALTER TABLE "([^"]+)"\s+(\w+)/g)) {
      expect(m[1].startsWith('CallCenterSlot') || m[1].startsWith('CallCenterRepHours'), m[0]).toBe(true)
      expect(m[2].toUpperCase()).toBe('ADD')
    }
    expect(sql).not.toMatch(/"Appointment|"AvailabilitySlot/)
  })
})
