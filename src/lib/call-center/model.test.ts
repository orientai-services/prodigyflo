import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HELD_UNTIL_MORNING,
  INTAKE_QUEUED,
  PREVIEW_BANNER,
  applyLeadAction,
  applyOutcome,
  attemptAlreadyCounted,
  autoTextDetail,
  deriveFollowUp,
  followUpOf,
  isExhausted,
  callNeedsConfirm,
  canCall,
  canSendIntake,
  canTake,
  canText,
  inboundFormMatch,
  lockLabel,
  nextCallableLead,
  nextTryLine,
  phoneLabel,
  saveNote,
  seedLeads,
  sendIntakeLink,
  takeLead,
  textHeldUntilMorning,
  triesLine,
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
  it('seeds the desk, a locked lead, a do-not-call row, and a disabled Spanish placeholder', () => {
    const leads = seedLeads()
    expect(leads).toHaveLength(9)
    expect(leads.filter((lead) => lead.language === 'en' && lead.channel === 'form' && !lead.contacted)).toHaveLength(4)
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
    const dnc = byName(leads, 'Riley Cho')
    expect(dnc.dnc).toBe(true)
    expect(dnc.status).toBe('dnc')
    expect(dnc.trail.some((event) => event.detail === 'STOP on a text')).toBe(true)
    expect(lockLabel(byName(leads, 'Chris Hale'))).toBe('Locked · Sam')
  })

  it('filters forms, inbound, uncontacted, retry, do not call, and language', () => {
    const leads = seedLeads()
    expect(visibleLeads(leads, 'all', 'all', '')).toHaveLength(9)
    expect(visibleLeads(leads, 'forms', 'all', '').every((lead) => lead.channel === 'form')).toBe(true)
    expect(visibleLeads(leads, 'forms', 'all', '')).toHaveLength(6)
    expect(visibleLeads(leads, 'inbound', 'all', '')).toHaveLength(3)
    const waiting = visibleLeads(leads, 'uncontacted', 'all', '')
    expect(waiting.every((lead) => !lead.contacted)).toBe(true)
    expect(waiting.map((lead) => lead.arrivedAt)).toEqual([...waiting.map((lead) => lead.arrivedAt)].sort())
    expect(waiting[0]?.name).toBe('Nate Fuller')
    expect(waiting.some((lead) => lead.dnc)).toBe(false)
    expect(visibleLeads(leads, 'dnc', 'all', '').map((lead) => lead.name)).toEqual(['Riley Cho'])
    expect(visibleLeads(leads, 'retry', 'all', '')).toHaveLength(0)
    expect(visibleLeads(leads, 'all', 'en', '').every((lead) => lead.language === 'en')).toBe(true)
    expect(visibleLeads(leads, 'all', 'es', '').map((lead) => lead.name)).toEqual(['Spanish placeholder'])
    expect(visibleLeads(leads, 'dnc', 'es', '')).toHaveLength(0)
    expect(visibleLeads(leads, 'all', 'en', 'mara').map((lead) => lead.id)).toEqual(['mara-ellison'])
  })

  it('stores last-4 only and keeps the comms trail in time order', () => {
    for (const lead of seedLeads()) {
      expect(lead.last4 === null || /^\d{4}$/.test(lead.last4)).toBe(true)
      const times = lead.trail.map((event) => event.at)
      expect(times).toEqual([...times].sort())
    }
  })

  it('records a dummy call or text without moving the row, and ignores the Spanish placeholder', () => {
    const leads = seedLeads()
    const at = '2026-09-29T17:00:00.000Z'
    const mara = applyLeadAction(byName(leads, 'Mara Ellison'), 'call', at)
    expect(mara.contacted).toBe(false)
    expect(mara.status).toBe('waiting')
    expect(mara.trail.at(-1)).toMatchObject({ kind: 'call', detail: PREVIEW_BANNER })
    expect(mara.recording?.label).toBe('Dummy recording')
    expect(byName(leads, 'Mara Ellison').contacted).toBe(false)

    const texted = applyLeadAction(mara, 'text', '2026-09-29T18:00:00.000Z')
    expect(texted.contacted).toBe(false)
    expect(texted.trail.at(-1)).toMatchObject({ kind: 'sms', detail: PREVIEW_BANNER })

    const placeholder = byName(leads, 'Spanish placeholder')
    expect(applyLeadAction(placeholder, 'call', at)).toBe(placeholder)
    expect(applyOutcome(placeholder, 'talked', at)).toBe(placeholder)
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
    expect(screen).not.toMatch(/router\.push/)
    expect(screen).toContain('<Link')
    expect(screen).toContain('href={item.href}')
    for (const href of ['/board', '/pipeline', '/clients', '/queue', '/call-center', '/documents', '/submissions']) {
      expect(screen).toContain(`href: '${href}'`)
    }
    expect(screen).toContain('Call anyway')
    expect(screen).toContain('Send intake link')
    expect(screen).toContain('Save note')
    expect(screen).toContain('Take')
    expect(screen).toContain('>Skip<')
    expect(screen).toContain('>Next<')
    expect(model).toContain(INTAKE_QUEUED)
    expect(model).toContain(HELD_UNTIL_MORNING)
    expect(screen).toContain('Spanish page later')
    expect(screen).toContain('aria-current="page"')
    expect(screen).toContain('lead.subtitle')
    expect(screen).toContain("if (next === 'es') setTab('all')")
    expect(screen).not.toContain('rail-foot')
    expect(model).toContain("name: 'Spanish placeholder'")
    expect(model).toContain("subtitle: 'page not connected'")
  })
})

describe('call center extras', () => {
  const day = '2026-10-03T17:00:00.000Z'

  it('moves talked and appointment to booked, and records the other results', () => {
    const leads = seedLeads()
    const talked = applyOutcome(byName(leads, 'Mara Ellison'), 'talked', day)
    expect(talked.status).toBe('booked')
    expect(talked.contacted).toBe(true)
    expect(talked.trail.at(-1)?.label).toBe('Talked')

    const booked = applyOutcome(byName(leads, 'Owen Briggs'), 'appointment', day)
    expect(booked.status).toBe('booked')
    expect(booked.trail.at(-1)?.detail).toBe('Moved to booked')

    const wrong = applyOutcome(byName(leads, 'Jonah Hale'), 'wrong_number', day)
    expect(wrong.status).toBe('waiting')
    expect(wrong.contacted).toBe(true)
    expect(wrong.trail.at(-1)?.label).toBe('Wrong number')

    const callback = applyOutcome(byName(leads, 'Nate Fuller'), 'callback', day)
    expect(callback.status).toBe('missed')
    expect(callback.trail.at(-1)?.detail).toBe('Result recorded')
    expect(applyOutcome(byName(leads, 'Lila Chen'), 'not_interested', day).trail.at(-1)?.label).toBe('Not interested')
  })

  // The fixed 1/3/7-day retry was replaced by the six-step cadence (cadence.ts).
  it('follows the no-answer cadence in the lead zone and stops after 7 tries', () => {
    let lead = byName(seedLeads(), 'Mara Ellison')
    // Tue Sep 29 2026, 10:00 PDT.
    let at = '2026-09-29T17:00:00.000Z'
    lead = applyOutcome(lead, 'no_answer', at)
    expect(lead.status).toBe('retry')
    expect(lead.tries).toBe(1)
    expect(lead.nextAttemptAt).toBe('2026-09-29T17:05:00.000Z')
    expect(lead.followUp).toBe('cadence')
    expect(triesLine(lead)).toBe('Tries 1 of 7')
    expect(nextTryLine(lead)).toBe('Next try Sep 29, 10:05 AM')
    expect(lead.trail.some((event) => event.detail === autoTextDetail('en'))).toBe(true)
    expect(visibleLeads([lead], 'retry', 'all', '').map((row) => row.id)).toEqual([lead.id])

    const expected = [
      ['busy', '2026-09-30T17:00:00.000Z'], // tomorrow 10:00
      ['voicemail', '2026-10-03T00:00:00.000Z'], // Fri Oct 2 17:00 (day after tomorrow from Wed)
      ['no_answer', '2026-10-05T00:00:00.000Z'], // +2 days, Sun 17:00
      ['busy', '2026-10-08T00:00:00.000Z'], // +3 days
      ['voicemail', '2026-10-11T00:00:00.000Z'], // +3 days
    ] as const
    for (const [outcome, next] of expected) {
      at = lead.nextAttemptAt ?? at
      lead = applyOutcome(lead, outcome, at)
      expect(lead.nextAttemptAt).toBe(next)
    }
    expect(lead.tries).toBe(6)
    expect(lead.trail.filter((event) => event.detail === autoTextDetail('en'))).toHaveLength(2)

    at = lead.nextAttemptAt ?? at
    lead = applyOutcome(lead, 'no_answer', at)
    expect(lead.tries).toBe(7)
    expect(lead.nextAttemptAt).toBeNull()
    expect(lead.status).toBe('waiting')
    expect(nextTryLine(lead)).toBe('No further tries')
    expect(isExhausted(lead)).toBe(true)
    expect(lead.trail.filter((event) => event.detail === autoTextDetail('en'))).toHaveLength(3)
    expect(applyOutcome(lead, 'voicemail', '2026-11-01T17:00:00.000Z')).toBe(lead)
    // Closing it still works.
    expect(applyOutcome(lead, 'not_interested', '2026-11-01T17:00:00.000Z').trail.at(-1)?.label).toBe('Not interested')
  })

  it('does not count a call twice when the carrier already counted it', () => {
    const lead = byName(seedLeads(), 'Mara Ellison')
    const carrier: CallLead = {
      ...lead,
      contacted: true,
      tries: 1,
      status: 'retry',
      nextAttemptAt: '2026-09-29T17:05:00.000Z',
      trail: [
        ...lead.trail,
        { kind: 'call', at: '2026-09-29T17:00:00.000Z', label: 'Call', detail: 'No answer', followUp: 'cadence' },
      ],
    }
    expect(attemptAlreadyCounted(carrier)).toBe(true)
    const after = applyOutcome(carrier, 'no_answer', '2026-09-29T17:01:00.000Z')
    expect(after.tries).toBe(1)
    expect(after.nextAttemptAt).toBe('2026-09-29T17:05:00.000Z')
    expect(after.trail.at(-2)).toMatchObject({ kind: 'outcome', label: 'No answer', detail: 'Next try Sep 29, 10:05 AM' })
    expect(after.trail.at(-2)?.followUp).toBeUndefined()
    // The rep's result is now the newest: a second result counts again.
    expect(attemptAlreadyCounted(after)).toBe(false)
    expect(applyOutcome(after, 'busy', '2026-09-29T17:02:00.000Z').tries).toBe(2)
  })

  it('stores an agreed callback time and tells it apart from a cadence retry', () => {
    const lead = byName(seedLeads(), 'Owen Briggs') // America/Phoenix
    const at = '2026-10-09T17:00:00.000Z'
    const cb = applyOutcome(lead, 'callback', at, 'You', { callbackAt: '2026-10-10T21:30:00.000Z' })
    expect(cb.nextAttemptAt).toBe('2026-10-10T21:30:00.000Z')
    expect(cb.followUp).toBe('callback')
    expect(followUpOf(cb)).toBe('callback')
    expect(cb.tries).toBe(0)
    expect(cb.contacted).toBe(true)
    expect(cb.trail.at(-1)).toMatchObject({ kind: 'outcome', label: 'Callback', detail: 'Call back Sat, Oct 10, 2:30 pm their time', followUp: 'callback' })
    expect(nextTryLine(cb)).toBe('Call back Oct 10, 2:30 PM')
    // Past or too far out: not saved.
    expect(applyOutcome(lead, 'callback', at, 'You', { callbackAt: '2026-10-09T16:00:00.000Z' })).toBe(lead)
    expect(applyOutcome(lead, 'callback', at, 'You', { callbackAt: '2027-01-01T17:00:00.000Z' })).toBe(lead)
    // A later booked result clears it.
    const booked = applyOutcome(cb, 'appointment', '2026-10-10T21:35:00.000Z')
    expect(booked.nextAttemptAt).toBeNull()
    expect(followUpOf(booked)).toBeNull()
  })

  it('reads the follow-up kind from the trail, with a fallback for old rows', () => {
    expect(deriveFollowUp([], 0, null)).toBeNull()
    expect(deriveFollowUp([], 2, '2026-10-10T17:00:00.000Z')).toBe('cadence')
    expect(deriveFollowUp([], 0, '2026-10-10T17:00:00.000Z')).toBe('callback')
    const marked = [
      { kind: 'outcome' as const, at: '2026-10-09T17:00:00.000Z', label: 'Callback', detail: '', followUp: 'callback' as const },
      { kind: 'note' as const, at: '2026-10-09T17:01:00.000Z', label: 'Note', detail: 'hi' },
    ]
    expect(deriveFollowUp(marked, 3, '2026-10-10T17:00:00.000Z')).toBe('callback')
  })

  it('locks a lead to one rep and skips leads that someone else holds', () => {
    const leads = seedLeads()
    const mara = takeLead(byName(leads, 'Mara Ellison'), 'You', day)
    expect(mara.lockedBy).toBe('You')
    expect(lockLabel(mara)).toBe('Locked to you')
    expect(mara.trail.at(-1)?.detail).toBe('You took this lead')
    expect(takeLead(mara, 'You', day)).toBe(mara)

    const chris = byName(leads, 'Chris Hale')
    expect(canCall(chris)).toBe(false)
    expect(canText(chris)).toBe(false)
    expect(canTake(chris)).toBe(false)
    expect(applyLeadAction(chris, 'call', day)).toBe(chris)
    expect(applyOutcome(chris, 'talked', day)).toBe(chris)

    const rows = [chris, byName(leads, 'Riley Cho'), byName(leads, 'Spanish placeholder'), mara]
    expect(nextCallableLead(rows, chris.id)?.id).toBe(mara.id)
    expect(nextCallableLead(rows, mara.id)?.id).toBe(mara.id)
  })

  it('saves a note and queues an intake link without creating a client', () => {
    const mara = byName(seedLeads(), 'Mara Ellison')
    expect(saveNote(mara, '   ', day)).toBe(mara)
    const noted = saveNote(mara, ' Porch was empty ', day)
    expect(noted.trail.at(-1)).toMatchObject({ kind: 'note', label: 'Note', detail: 'Porch was empty' })
    const queued = sendIntakeLink(noted, day)
    expect(queued.trail.at(-1)).toMatchObject({ kind: 'intake', detail: INTAKE_QUEUED })
    expect(queued).not.toHaveProperty('clientId')

    const riley = byName(seedLeads(), 'Riley Cho')
    expect(sendIntakeLink(riley, day)).toBe(riley)
    expect(canSendIntake(riley)).toBe(false)
    const spanish = byName(seedLeads(), 'Spanish placeholder')
    expect(saveNote(spanish, 'no', day)).toBe(spanish)
  })

  it('dims do-not-call and keeps the phone at last-4', () => {
    const riley = byName(seedLeads(), 'Riley Cho')
    expect(phoneLabel(riley)).toBe('···· 0091')
    expect(canCall(riley)).toBe(false)
    expect(canText(riley)).toBe(false)
    expect(canTake(riley)).toBe(false)
    expect(applyLeadAction(riley, 'text', day)).toBe(riley)
    const added = applyOutcome(byName(seedLeads(), 'Mara Ellison'), 'do_not_call', day)
    expect(added.dnc).toBe(true)
    expect(added.status).toBe('dnc')
    expect(phoneLabel(added)).toBe('···· 4419')
    expect(applyLeadAction(added, 'call', day)).toBe(added)
    expect(sendIntakeLink(added, day)).toBe(added)
  })

  it('asks before a call outside 8am–9pm and holds texts outside 9am–8pm', () => {
    const mara = byName(seedLeads(), 'Mara Ellison')
    expect(callNeedsConfirm(mara, '2026-01-15T16:00:00.000Z')).toBe(false)
    expect(textHeldUntilMorning(mara, '2026-01-15T16:00:00.000Z')).toBe(true)
    expect(callNeedsConfirm(mara, '2026-01-15T17:00:00.000Z')).toBe(false)
    expect(textHeldUntilMorning(mara, '2026-01-15T17:00:00.000Z')).toBe(false)
    expect(textHeldUntilMorning(mara, '2026-01-16T04:00:00.000Z')).toBe(true)
    expect(callNeedsConfirm(mara, '2026-01-16T04:00:00.000Z')).toBe(false)
    expect(callNeedsConfirm(mara, '2026-01-16T05:00:00.000Z')).toBe(true)
    expect(callNeedsConfirm(mara, '2026-01-15T15:30:00.000Z')).toBe(true)

    const held = applyLeadAction(mara, 'text', '2026-01-15T15:30:00.000Z')
    expect(held.trail.some((event) => event.detail === HELD_UNTIL_MORNING)).toBe(true)
    const owen = byName(seedLeads(), 'Owen Briggs')
    expect(owen.timeZone).toBe('America/Phoenix')
    expect(callNeedsConfirm(owen, '2026-07-15T15:00:00.000Z')).toBe(false)
    expect(textHeldUntilMorning(owen, '2026-07-15T15:00:00.000Z')).toBe(true)
  })

  it('matches an inbound last-4 to a recent form and says when there is none', () => {
    const leads = seedLeads()
    expect(inboundFormMatch(byName(leads, 'Lila Chen'), leads)).toBe('Possible match: Jonah Hale')
    expect(inboundFormMatch(byName(leads, 'Nate Fuller'), leads)).toBe('No form match')
    expect(inboundFormMatch(byName(leads, 'Helen Cho'), leads)).toBe('No form match')
    expect(inboundFormMatch(byName(leads, 'Mara Ellison'), leads)).toBeNull()
  })
})
