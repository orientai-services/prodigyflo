import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyLeadAction,
  seedLeads,
  visibleLeads,
  type CallLead,
} from './model'

const root = path.resolve(__dirname, '../..')

function byName(leads: CallLead[], name: string): CallLead {
  const lead = leads.find((row) => row.name === name)
  if (!lead) throw new Error(`missing ${name}`)
  return lead
}

describe('call center door', () => {
  it('seeds two uncontacted English forms, one inbound, one missed, one booked, and a disabled Spanish placeholder', () => {
    const leads = seedLeads()
    expect(leads).toHaveLength(6)
    expect(leads.filter((lead) => lead.language === 'en' && lead.channel === 'form' && !lead.contacted)).toHaveLength(2)
    expect(leads.filter((lead) => lead.language === 'en' && lead.status === 'inbound')).toHaveLength(1)
    expect(leads.filter((lead) => lead.status === 'missed' && lead.recording?.label === 'Dummy short recording')).toHaveLength(1)
    const booked = leads.find((lead) => lead.status === 'booked')
    expect(booked?.recording?.label).toBe('Dummy connected recording')
    expect(booked?.trail.some((event) => event.kind === 'sms')).toBe(true)
    const spanish = leads.find((lead) => lead.language === 'es')
    expect(spanish).toMatchObject({
      name: 'Spanish placeholder',
      subtitle: 'page not connected',
      disabled: true,
      page: 'page not connected',
      last4: null,
    })
    expect(leads.filter((lead) => lead.language === 'es' && !lead.disabled)).toHaveLength(0)
  })

  it('defaults to every lead, then filters forms, inbound, contact, status, and language', () => {
    const leads = seedLeads()
    expect(visibleLeads(leads, 'all', 'all', '')).toHaveLength(6)
    expect(visibleLeads(leads, 'forms', 'all', '').every((lead) => lead.channel === 'form')).toBe(true)
    expect(visibleLeads(leads, 'forms', 'all', '')).toHaveLength(3)
    expect(visibleLeads(leads, 'inbound', 'all', '')).toHaveLength(3)
    expect(visibleLeads(leads, 'uncontacted', 'all', '').every((lead) => !lead.contacted)).toBe(true)
    expect(visibleLeads(leads, 'missed', 'all', '').map((lead) => lead.name)).toEqual(['Nate Fuller'])
    expect(visibleLeads(leads, 'booked', 'all', '').map((lead) => lead.name)).toEqual(['Helen Cho'])
    expect(visibleLeads(leads, 'all', 'en', '').every((lead) => lead.language === 'en')).toBe(true)
    expect(visibleLeads(leads, 'all', 'es', '').map((lead) => lead.name)).toEqual(['Spanish placeholder'])
    expect(visibleLeads(leads, 'booked', 'es', '')).toHaveLength(0)
    expect(visibleLeads(leads, 'all', 'en', 'mara').map((lead) => lead.id)).toEqual(['mara-ellison'])
  })

  it('stores last-4 only and keeps the comms trail in time order', () => {
    for (const lead of seedLeads()) {
      expect(lead.last4 === null || /^\d{4}$/.test(lead.last4)).toBe(true)
      const times = lead.trail.map((event) => event.at)
      expect(times).toEqual([...times].sort())
    }
  })

  it('updates only the dummy row for call, text, book, and missed', () => {
    const leads = seedLeads()
    const mara = applyLeadAction(byName(leads, 'Mara Ellison'), 'call', '2026-09-29T20:00:00.000Z')
    expect(mara.contacted).toBe(true)
    expect(mara.trail.at(-1)?.kind).toBe('call')
    expect(mara.recording?.label).toBe('Dummy recording')
    expect(byName(leads, 'Mara Ellison').contacted).toBe(false)

    const texted = applyLeadAction(mara, 'text', '2026-09-29T20:01:00.000Z')
    expect(texted.trail.at(-1)?.kind).toBe('sms')

    const booked = applyLeadAction(texted, 'book', '2026-09-29T20:02:00.000Z')
    expect(booked.status).toBe('booked')
    expect(booked.trail.map((event) => event.at)).toEqual([...booked.trail.map((event) => event.at)].sort())

    const missed = applyLeadAction(byName(leads, 'Owen Briggs'), 'missed', '2026-09-29T20:03:00.000Z')
    expect(missed.status).toBe('missed')
    expect(missed.recording?.label).toBe('Dummy short recording')

    const placeholder = byName(leads, 'Spanish placeholder')
    expect(applyLeadAction(placeholder, 'call', '2026-09-29T20:04:00.000Z')).toBe(placeholder)
  })

  it('does not call Twilio, Meta, or the intake desk', () => {
    const screen = readFileSync(path.join(root, 'components/call-center/call-center.tsx'), 'utf8')
    const model = readFileSync(path.join(root, 'lib/call-center/model.ts'), 'utf8')
    const page = readFileSync(path.join(root, 'app/(app)/call-center/page.tsx'), 'utf8')
    const bundle = `${screen}\n${model}\n${page}`
    expect(bundle).toContain('Ad form fills and inbound on the ad number. Not the SCS intake journey.')
    expect(bundle).toContain('Preview. Twilio is not connected.')
    expect(bundle).toContain('Voice not connected')
    expect(bundle).toContain('Working language')
    expect(bundle).not.toMatch(/\bfetch\s*\(/)
    expect(bundle).not.toMatch(/from ['"]twilio|graph\.facebook|meta\.com|process\.env|\bSES\b|\$\d/)
    expect(screen).not.toMatch(/<a\b|href=|router\.push/)
    expect(screen).toContain('Spanish page later')
    expect(screen).toContain('aria-current="page"')
    expect(screen).toContain('lead.subtitle')
    expect(screen).toContain("if (next === 'es') setTab('all')")
    expect(screen).not.toContain('rail-foot')
    expect(model).toContain("name: 'Spanish placeholder'")
    expect(model).toContain("subtitle: 'page not connected'")
  })
})
