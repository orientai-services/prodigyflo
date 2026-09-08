import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { creditWallet, debitWallet, ensureWallet } from '@/lib/telephony/billing'

/**
 * The wallet's billing mode against a real database.
 *
 * This exists because of a bug that reached production: the migration that
 * backfilled wallets for existing accounts could not read
 * TELEPHONY_INTERNAL_SLUGS from SQL, so it gave every account the column
 * default (WALLET) — including the internal accounts, which are meant to bill
 * to the agency card. They ended up gated on a prepaid balance they will never
 * have, the exact opposite of the intent.
 *
 * The fix is that ensureWallet keeps re-deriving the mode for as long as the
 * wallet has no history, and stops the moment it has any. Both halves are
 * pinned here.
 */
const stamp = `telwallet-${Date.now()}`
const orgIds: string[] = []

async function makeOrg(slug: string, kind: 'AGENCY' | 'CLIENT'): Promise<string> {
  const org = await db.organization.create({
    data: { name: `Wallet test ${slug}`, slug, kind },
    select: { id: true },
  })
  orgIds.push(org.id)
  return org.id
}

beforeAll(async () => {
  process.env.TELEPHONY_INTERNAL_SLUGS = `${stamp}-house,${stamp}-other`
})

afterAll(async () => {
  await db.walletEntry.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.telephonyWallet.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.organization.deleteMany({ where: { id: { in: orgIds } } })
  delete process.env.TELEPHONY_INTERNAL_SLUGS
})

describe('wallet billing mode', () => {
  it('puts an outside client on a prepaid wallet', async () => {
    const id = await makeOrg(`${stamp}-outsider`, 'CLIENT')
    expect((await ensureWallet(id)).billingMode).toBe('WALLET')
  })

  it('puts a listed internal account and the agency on the card', async () => {
    const house = await makeOrg(`${stamp}-house`, 'CLIENT')
    const agency = await makeOrg(`${stamp}-agency`, 'AGENCY')
    expect((await ensureWallet(house)).billingMode).toBe('AGENCY_CARD')
    expect((await ensureWallet(agency)).billingMode).toBe('AGENCY_CARD')
  })

  it('corrects a wallet that was created with the wrong mode and never used', async () => {
    const id = await makeOrg(`${stamp}-other`, 'CLIENT')
    // Exactly what the backfill migration produced: the column default.
    await db.telephonyWallet.create({ data: { organizationId: id, billingMode: 'WALLET' } })
    expect((await ensureWallet(id)).billingMode).toBe('AGENCY_CARD')
  })

  it('never re-derives a wallet that has history — a deliberate change sticks', async () => {
    const id = await makeOrg(`${stamp}-funded`, 'CLIENT')
    await db.telephonyWallet.create({ data: { organizationId: id, billingMode: 'WALLET' } })
    await creditWallet({
      organizationId: id,
      kind: 'TOPUP',
      amountCents: 2500,
      description: 'funds received',
    })
    // Now listed as internal, but it has a funded balance and a ledger entry.
    process.env.TELEPHONY_INTERNAL_SLUGS = `${stamp}-funded`
    const wallet = await ensureWallet(id)
    expect(wallet.billingMode).toBe('WALLET')
    expect(wallet.balanceCents).toBe(2500)
    process.env.TELEPHONY_INTERNAL_SLUGS = `${stamp}-house,${stamp}-other`
  })

  it('charges an agency-card account without ever moving a balance', async () => {
    const id = await makeOrg(`${stamp}-card`, 'AGENCY')
    // A charge on an account with a zero balance: on a WALLET account this
    // would throw InsufficientFundsError, which is precisely the gate the
    // agency card is meant to bypass.
    await debitWallet({
      organizationId: id,
      kind: 'NUMBER_MONTHLY',
      amountCents: 300,
      description: 'a line on the agency card',
    })
    const wallet = await ensureWallet(id)
    expect(wallet.balanceCents).toBe(0)
    // The entry is still recorded, so the owner sees what the card is paying for.
    expect(wallet.agencyChargedCents).toBe(300)
  })

  it('refuses the same charge on an unfunded prepaid wallet', async () => {
    const id = await makeOrg(`${stamp}-broke`, 'CLIENT')
    await ensureWallet(id)
    await expect(
      debitWallet({
        organizationId: id,
        kind: 'NUMBER_MONTHLY',
        amountCents: 300,
        description: 'a line nobody paid for',
      }),
    ).rejects.toThrow(/short/i)
    expect((await ensureWallet(id)).balanceCents).toBe(0)
  })
})
