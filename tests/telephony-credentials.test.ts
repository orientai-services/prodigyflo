import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/crypto'
import { telephonyCredentials } from '@/lib/telephony'

/**
 * Where an account's carrier credentials come from.
 *
 * An agency runs its client accounts on ONE Twilio account, so pasting the
 * same token into every client account would be busywork with three chances to
 * fat-finger it. A client account therefore inherits its agency's credentials
 * — but only as a fallback, so a client that brings its own carrier still wins.
 */
const stamp = `telcreds-${Date.now()}`
let agencyId: string
let childId: string
let standaloneId: string

const envBackup = {
  sid: process.env.TWILIO_ACCOUNT_SID,
  token: process.env.TWILIO_AUTH_TOKEN,
}

/** Stores twilio-sms credentials in the vault for one org. */
async function storeCredentials(organizationId: string, accountSid: string, authToken: string) {
  const connector = await db.connector.upsert({
    where: { organizationId_kind: { organizationId, kind: 'TWILIO_SMS' } },
    update: { isEnabled: true },
    create: { organizationId, kind: 'TWILIO_SMS', name: 'Twilio SMS', isEnabled: true },
    select: { id: true },
  })
  for (const [fieldKey, value] of Object.entries({ accountSid, authToken })) {
    const enc = encryptSecret(value)
    await db.connectorCredential.upsert({
      where: { connectorId_fieldKey: { connectorId: connector.id, fieldKey } },
      update: { ...enc },
      create: { organizationId, connectorId: connector.id, fieldKey, ...enc },
    })
  }
}

beforeAll(async () => {
  const agency = await db.organization.create({
    data: { name: 'Creds agency', slug: `${stamp}-agency`, kind: 'AGENCY' },
    select: { id: true },
  })
  agencyId = agency.id
  const child = await db.organization.create({
    data: { name: 'Creds child', slug: `${stamp}-child`, kind: 'CLIENT', parentOrganizationId: agencyId },
    select: { id: true },
  })
  childId = child.id
  const standalone = await db.organization.create({
    data: { name: 'Creds standalone', slug: `${stamp}-solo`, kind: 'CLIENT' },
    select: { id: true },
  })
  standaloneId = standalone.id
})

afterEach(() => {
  delete process.env.TWILIO_ACCOUNT_SID
  delete process.env.TWILIO_AUTH_TOKEN
})

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: [childId, standaloneId, agencyId] } } })
  if (envBackup.sid) process.env.TWILIO_ACCOUNT_SID = envBackup.sid
  if (envBackup.token) process.env.TWILIO_AUTH_TOKEN = envBackup.token
})

describe('carrier credential resolution', () => {
  it('finds nothing when nothing is configured anywhere', async () => {
    expect(await telephonyCredentials(childId)).toBeNull()
  })

  it("lets a client account inherit its agency's credentials", async () => {
    await storeCredentials(agencyId, 'ACagency', 'agency-token')
    expect(await telephonyCredentials(childId)).toEqual({
      accountSid: 'ACagency',
      authToken: 'agency-token',
    })
  })

  it("prefers the account's own credentials over the agency's", async () => {
    await storeCredentials(agencyId, 'ACagency', 'agency-token')
    await storeCredentials(childId, 'ACchild', 'child-token')
    expect(await telephonyCredentials(childId)).toEqual({
      accountSid: 'ACchild',
      authToken: 'child-token',
    })
  })

  it('never inherits sideways — a standalone account sees no agency', async () => {
    await storeCredentials(agencyId, 'ACagency', 'agency-token')
    expect(await telephonyCredentials(standaloneId)).toBeNull()
  })

  it('falls back to the server environment when no vault entry applies', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACenv'
    process.env.TWILIO_AUTH_TOKEN = 'env-token'
    expect(await telephonyCredentials(standaloneId)).toEqual({
      accountSid: 'ACenv',
      authToken: 'env-token',
    })
  })
})
