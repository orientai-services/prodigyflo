import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import {
  agencyPassphraseStatus,
  clearAgencyPassphrase,
  setAgencyPassphrase,
  verifyAgencyPassphrase,
} from '@/lib/telephony/passphrase'

/**
 * The passphrase stored on the organization — the path that lets the owner
 * turn the money gate on from a browser instead of a shell on the server.
 *
 * The value on the row is a bcrypt hash that is itself encrypted with
 * VAULT_KEY, so these tests also pin that nothing readable is ever written.
 */
const stamp = `telpass-${Date.now()}`
let orgId: string

const envBackup = {
  hash: process.env.TELEPHONY_AGENCY_PASSPHRASE_HASH,
  plain: process.env.TELEPHONY_AGENCY_PASSPHRASE,
}

beforeAll(async () => {
  const org = await db.organization.create({
    data: { name: 'Passphrase test', slug: stamp, kind: 'AGENCY' },
    select: { id: true },
  })
  orgId = org.id
})

afterEach(() => {
  delete process.env.TELEPHONY_AGENCY_PASSPHRASE_HASH
  delete process.env.TELEPHONY_AGENCY_PASSPHRASE
})

afterAll(async () => {
  await db.organization.delete({ where: { id: orgId } })
  if (envBackup.hash) process.env.TELEPHONY_AGENCY_PASSPHRASE_HASH = envBackup.hash
  if (envBackup.plain) process.env.TELEPHONY_AGENCY_PASSPHRASE = envBackup.plain
})

async function storedBlob(): Promise<Record<string, unknown> | null> {
  const org = await db.organization.findUniqueOrThrow({
    where: { id: orgId },
    select: { settings: true },
  })
  const telephony = (org.settings as Record<string, unknown>)?.telephony as
    | Record<string, unknown>
    | undefined
  return (telephony?.provisioningPassphrase as Record<string, unknown>) ?? null
}

describe('the passphrase stored on the organization', () => {
  it('starts unset and refuses everything', async () => {
    expect(await agencyPassphraseStatus(orgId)).toEqual({ configured: false, source: null })
    const res = await verifyAgencyPassphrase('anything', { organizationId: orgId })
    expect(res.ok).toBe(false)
  })

  it('accepts what the owner set, and only that', async () => {
    expect(await setAgencyPassphrase(orgId, 'a good long passphrase')).toEqual({ ok: true })
    expect(await agencyPassphraseStatus(orgId)).toEqual({ configured: true, source: 'app' })
    expect((await verifyAgencyPassphrase('a good long passphrase', { organizationId: orgId })).ok).toBe(true)
    expect((await verifyAgencyPassphrase('a good long passphras', { organizationId: orgId })).ok).toBe(false)
  })

  it('writes nothing readable to the row — the hash itself is encrypted', async () => {
    await setAgencyPassphrase(orgId, 'another good passphrase')
    const blob = await storedBlob()
    expect(blob).not.toBeNull()
    expect(Object.keys(blob!).sort()).toEqual(['authTag', 'ciphertext', 'iv', 'keyVersion'])
    const serialized = JSON.stringify(blob)
    expect(serialized).not.toContain('another good passphrase')
    // Not even the bcrypt hash is stored in the clear.
    expect(serialized).not.toMatch(/\$2[aby]?\$\d{2}\$/)
  })

  it('rejects a passphrase too short to be worth having', async () => {
    const res = await setAgencyPassphrase(orgId, 'short')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(/8 characters/)
  })

  it('takes precedence over the server environment variable', async () => {
    await setAgencyPassphrase(orgId, 'the stored one')
    process.env.TELEPHONY_AGENCY_PASSPHRASE_HASH = bcrypt.hashSync('the env one', 10)
    expect(await agencyPassphraseStatus(orgId)).toEqual({ configured: true, source: 'app' })
    expect((await verifyAgencyPassphrase('the stored one', { organizationId: orgId })).ok).toBe(true)
    expect((await verifyAgencyPassphrase('the env one', { organizationId: orgId })).ok).toBe(false)
  })

  it('falls back to the environment once the stored one is removed', async () => {
    await setAgencyPassphrase(orgId, 'the stored one')
    await clearAgencyPassphrase(orgId)
    process.env.TELEPHONY_AGENCY_PASSPHRASE_HASH = bcrypt.hashSync('the env one', 10)
    expect(await agencyPassphraseStatus(orgId)).toEqual({ configured: true, source: 'env' })
    expect((await verifyAgencyPassphrase('the env one', { organizationId: orgId })).ok).toBe(true)
    expect((await verifyAgencyPassphrase('the stored one', { organizationId: orgId })).ok).toBe(false)
  })

  it('closes rather than opens when the stored blob will not decrypt', async () => {
    await setAgencyPassphrase(orgId, 'the stored one')
    // What a rotated VAULT_KEY or a tampered row looks like.
    const blob = await storedBlob()
    await db.organization.update({
      where: { id: orgId },
      data: {
        settings: {
          telephony: { provisioningPassphrase: { ...blob, ciphertext: 'bm90LXJlYWwtY2lwaGVydGV4dA==' } },
        },
      },
    })
    expect(await agencyPassphraseStatus(orgId)).toEqual({ configured: false, source: null })
    expect((await verifyAgencyPassphrase('the stored one', { organizationId: orgId })).ok).toBe(false)
  })

  it('leaves sibling settings untouched when it writes', async () => {
    await db.organization.update({
      where: { id: orgId },
      data: { settings: { closeOps: { phase: 2 } } },
    })
    await setAgencyPassphrase(orgId, 'a good long passphrase')
    const org = await db.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { settings: true },
    })
    expect((org.settings as Record<string, unknown>).closeOps).toEqual({ phase: 2 })
  })
})
