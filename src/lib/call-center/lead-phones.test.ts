import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { makeOrg, makeUser, testNumber } from '../../../tests/fixtures/telephony'
import { leadPhonesFor, withLeadPhones } from './lead-phones'
import { ingestCallCenterMetaLead } from './meta-ingest'
import { SCS_ENGLISH_PAGE_ID } from './meta-route'
import { formatLeadPhone, type LeadPhoneView } from './phone-display'

/**
 * Full lead numbers against the test DB (docs/DIALER_APP.md §Phone numbers):
 * a Super Admin reads every lead in the workspace, a rep only the one they
 * hold off do-not-call, another workspace nothing, and a secret that won't
 * decrypt reads "unavailable" rather than dots.
 */
const run = `ccphone-${Date.now().toString(36)}`
const AT = new Date('2026-10-13T17:00:00.000Z')

describe('lead phones', () => {
  let orgId = ''
  let otherOrgId = ''
  const ids = { held: '', open: '', dnc: '', broken: '', bare: '' }
  const held = testNumber(run, 1)
  let admin: Awaited<ReturnType<typeof makeUser>>
  let rep: Awaited<ReturnType<typeof makeUser>>
  let outsider: Awaited<ReturnType<typeof makeUser>>

  async function lead(n: number, phone?: string) {
    const saved = await ingestCallCenterMetaLead({
      organizationId: orgId,
      pageId: SCS_ENGLISH_PAGE_ID,
      lead: { leadgenId: `${run}-${n}`, createdTime: AT.toISOString(), fields: { full_name: `Lead ${n}`, ...(phone ? { phone_number: phone } : {}) } },
    })
    return saved.leadId
  }

  beforeAll(async () => {
    orgId = (await makeOrg(run, 'Phones')).orgId
    otherOrgId = (await makeOrg(run, 'Elsewhere')).orgId
    admin = await makeUser(orgId, run, 'Admin Phones', 'SUPER_ADMIN')
    rep = await makeUser(orgId, run, 'Rep Phones', 'CLOSER')
    outsider = await makeUser(otherOrgId, run, 'Other Admin', 'SUPER_ADMIN')
    ids.held = await lead(1, held)
    ids.open = await lead(2, testNumber(run, 2))
    ids.dnc = await lead(3, testNumber(run, 3))
    ids.broken = await lead(4, testNumber(run, 4))
    ids.bare = await lead(5)
    await db.callCenterLead.update({ where: { id: ids.held }, data: { lockedBy: rep.id } })
    await db.callCenterLead.update({ where: { id: ids.dnc }, data: { lockedBy: rep.id, doNotCallAt: AT } })
    // A secret sealed with another key: GCM refuses it.
    await db.callCenterLead.update({
      where: { id: ids.broken },
      data: { phoneSecret: { ciphertext: 'AAAA', iv: 'AAAAAAAAAAAAAAAA', authTag: 'AAAAAAAAAAAAAAAAAAAAAA==', keyVersion: 1 } },
    })
  })

  afterAll(async () => {
    for (const id of [orgId, otherOrgId]) if (id) await db.organization.delete({ where: { id } })
  })

  it('a Super Admin reads every lead in the workspace, an unreadable one as unavailable', async () => {
    const phones = await leadPhonesFor(admin.actor, Object.values(ids))
    expect(phones.get(ids.held)).toEqual({ state: 'shown', ...formatLeadPhone(held) })
    expect(phones.get(ids.open)?.state).toBe('shown')
    expect(phones.get(ids.dnc)?.state).toBe('shown')
    expect(phones.get(ids.broken)).toEqual({ state: 'unavailable' })
    // No number on file at all: nothing, so the row shows "—".
    expect(phones.has(ids.bare)).toBe(false)
  })

  it('a rep reads every visible record including open and do-not-call leads', async () => {
    const phones = await leadPhonesFor(rep.actor, Object.values(ids))
    expect(phones.get(ids.held)?.state).toBe('shown')
    expect(phones.get(ids.open)?.state).toBe('shown')
    expect(phones.get(ids.dnc)?.state).toBe('shown')
    expect(phones.get(ids.broken)?.state).toBe('unavailable')
  })

  it('another workspace reads nothing', async () => {
    expect((await leadPhonesFor(outsider.actor, Object.values(ids))).size).toBe(0)
  })

  it('withLeadPhones puts phone only on the rows it may', async () => {
    const input: { id: string; phone?: LeadPhoneView | null }[] = [{ id: ids.held }, { id: ids.open }, { id: 'x' }]
    const rows = await withLeadPhones(rep.actor, input, (r) => r.id)
    expect(rows.map((r) => r.phone?.state ?? null)).toEqual(['shown', 'shown', null])
  })
})
