import { describe, expect, it } from 'vitest'
import {
  agoLabel,
  canCysSignUp,
  canResendProfile,
  canScsIntake,
  handoffChip,
  intakeSentLine,
  profileStateOf,
  seedLeads,
  type CallLead,
} from './model'
import { callLeadFromRow, intakeOf, intakeTextBlock, handoffOf, withDeskLinks, type StoredCallCenterLead } from './from-rows'
import { facebookFormEventBody } from './meta-route'

const NOW = Date.parse('2026-10-12T18:00:00.000Z')

function row(overrides: Partial<StoredCallCenterLead> = {}): StoredCallCenterLead {
  return {
    id: 'meta:org:lg-1',
    pageId: '1333173556539688',
    source: 'FORM',
    language: 'EN',
    status: 'WAITING',
    tries: 0,
    nextAttemptAt: null,
    lockedBy: 'rep-1',
    doNotCallAt: null,
    phoneLast4: '0199',
    createdAt: new Date('2026-10-12T15:00:00.000Z'),
    events: [{ type: 'FORM', body: facebookFormEventBody({ leadgenId: 'lg-1', name: 'Pat Example', zip: '89117' }), createdAt: new Date('2026-10-12T15:00:00.000Z') }],
    ...overrides,
  }
}

function lead(overrides: Partial<CallLead> = {}): CallLead {
  return { ...callLeadFromRow(row(), 'rep-1'), ...overrides }
}

describe('CYS bridge lead states (docs/CYS_BRIDGE.md §B2)', () => {
  it('walks the four states: no intake, link sent, analysing, linked', () => {
    expect(profileStateOf({ clientId: null, intake: null })).toBe('no_intake')
    expect(profileStateOf({ clientId: null, intake: { sentAt: '2026-10-12T17:00:00.000Z', mode: 'text' } })).toBe('link_sent')
    expect(profileStateOf({ clientId: 'c1', intake: null }, true)).toBe('analysing')
    expect(profileStateOf({ clientId: 'c1', intake: null })).toBe('linked')
  })

  it('says when and how the link went out', () => {
    expect(intakeSentLine({ sentAt: '2026-10-12T17:57:00.000Z', mode: 'text' }, NOW)).toBe('Intake link sent 3 min ago via text')
    expect(intakeSentLine({ sentAt: '2026-10-12T16:00:00.000Z', mode: 'open' }, NOW)).toBe('Intake link sent 2 h ago via opened with client')
    expect(intakeSentLine({ sentAt: '2026-10-12T17:59:30.000Z', mode: null }, NOW)).toBe('Intake link sent just now')
    expect(agoLabel('2026-10-09T17:00:00.000Z', NOW)).toBe('Oct 9')
  })

  it('gates SCS Intake to an unlinked lead the rep may work, and CYS Sign up to a linked one', () => {
    expect(canScsIntake(lead(), 'rep-1')).toBe(true)
    expect(canScsIntake(lead({ clientId: 'c1' }), 'rep-1')).toBe(false)
    expect(canScsIntake(lead({ dnc: true }), 'rep-1')).toBe(false)
    expect(canScsIntake(lead(), 'rep-2')).toBe(false)
    expect(canCysSignUp(lead(), true)).toBe(false)
    expect(canCysSignUp(lead({ clientId: 'c1' }), true)).toBe(true)
    expect(canCysSignUp(lead({ clientId: 'c1' }), false)).toBe(false)
    expect(canCysSignUp(lead({ clientId: 'c1' }), false, true)).toBe(true)
  })

  it('labels each hand-off status and offers Re-send only for a stale standby or started lead', () => {
    expect(handoffChip(null)).toBeNull()
    expect(handoffChip({ status: 'STANDBY', at: null })).toBe('In SunOff · Standby')
    expect(handoffChip({ status: 'STARTED', at: null })).toBe('In SunOff · Started')
    expect(handoffChip({ status: 'SUBMITTED', at: null })).toBe('In SunOff · Submitted')
    expect(handoffChip({ status: 'ERROR', at: null })).toContain('Retry')
    expect(canResendProfile({ status: 'STANDBY', at: null, stale: true })).toBe(true)
    expect(canResendProfile({ status: 'STANDBY', at: null, stale: false })).toBe(false)
    expect(canResendProfile({ status: 'SUBMITTED', at: null, stale: true })).toBe(false)
  })
})

describe('reading the link from stored rows', () => {
  it('takes the newest sent link and its mode, skipping the receiver’s "linked" row', () => {
    const events = [
      ...row().events,
      { type: 'INTAKE_LINK', body: JSON.stringify({ mode: 'copy', tokenId: 't1' }), createdAt: new Date('2026-10-12T16:00:00.000Z') },
      { type: 'INTAKE_LINK', body: JSON.stringify({ mode: 'text', tokenId: 't2' }), createdAt: new Date('2026-10-12T17:00:00.000Z') },
      { type: 'INTAKE_LINK', body: 'linked', createdAt: new Date('2026-10-12T17:30:00.000Z') },
    ]
    expect(intakeOf({ events, intakeLinkSentAt: null })).toEqual({ sentAt: '2026-10-12T17:00:00.000Z', mode: 'text' })
    expect(intakeOf({ events: row().events, intakeLinkSentAt: new Date('2026-10-11T10:00:00.000Z') })).toEqual({ sentAt: '2026-10-11T10:00:00.000Z', mode: null })
    expect(intakeOf({ events: row().events, intakeLinkSentAt: null })).toBeNull()
  })

  it('shows plain trail lines for the new events, never raw JSON', () => {
    const lead = callLeadFromRow(row({
      events: [
        ...row().events,
        { type: 'INTAKE_LINK', body: JSON.stringify({ mode: 'text', tokenId: 't2' }), createdAt: new Date('2026-10-12T17:00:00.000Z') },
        { type: 'HANDOFF', body: JSON.stringify({ status: 'standby' }), createdAt: new Date('2026-10-12T17:40:00.000Z') },
      ],
    }), 'rep-1')
    expect(lead.trail.map((event) => event.detail)).toEqual(['Form received on Solar Contract Services', 'SCS Intake link texted', 'SunOff · standby'])
    expect(lead.trail.at(-1)?.label).toBe('CYS Sign up')
  })

  it('reads the newest hand-off status, any case', () => {
    expect(handoffOf({ events: [
      { type: 'HANDOFF', body: JSON.stringify({ status: 'standby' }), createdAt: new Date('2026-10-12T17:00:00.000Z') },
      { type: 'HANDOFF', body: JSON.stringify({ status: 'STARTED' }), createdAt: new Date('2026-10-12T17:30:00.000Z') },
      { type: 'HANDOFF', body: '{"status":"bogus"}', createdAt: new Date('2026-10-12T17:40:00.000Z') },
    ] })).toEqual({ status: 'STARTED', at: '2026-10-12T17:30:00.000Z' })
  })

  it('leaves clientId out when the loader did not read it, so the desk keeps its own', () => {
    expect('clientId' in callLeadFromRow(row(), 'rep-1')).toBe(false)
    expect(callLeadFromRow(row({ clientId: 'c9' }), 'rep-1').clientId).toBe('c9')
  })

  it('fills the link and the texting gate onto real rows only', () => {
    const real = callLeadFromRow(row(), 'rep-1')
    const seed = seedLeads()[0]
    const base = { intakeLinkSentAt: null, consentAt: new Date(), consentRevokedAt: null, doNotCallAt: null }
    const [linked, untouched] = withDeskLinks([real, seed], [{ id: real.id, clientId: 'c1', ...base }, { id: seed.id, clientId: 'x', ...base }], true)
    expect(linked.clientId).toBe('c1')
    expect(linked.intakeTextBlock).toBeNull()
    expect(untouched).toBe(seed)
    expect(intakeTextBlock({ ...base, consentAt: null }, true)).toBe('No texting consent on file')
    expect(intakeTextBlock({ ...base, consentRevokedAt: new Date() }, true)).toBe('No texting consent on file')
    expect(intakeTextBlock({ ...base, doNotCallAt: new Date() }, true)).toBe('Do not call')
    expect(intakeTextBlock(base, false)).toBe('Texting isn’t live yet')
  })
})
