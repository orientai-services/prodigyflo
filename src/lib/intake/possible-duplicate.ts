import type { Prisma } from '@prisma/client'

/** Lower-cased letters only, so "Daryl  Schelin" and "daryl schelin" agree. */
export function normalizeName(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z]/g, '')
}

export function phoneDigits(value: string | null | undefined): string {
  const digits = (value ?? '').replace(/\D/g, '')
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
}

export type PossibleDuplicate = { clientId: string; matchedOn: 'name+phone' | 'name+email' }

type Candidate = { id: string; firstName: string; lastName: string; email: string; phone: string }

/** Pure rule: same normalized first+last name AND (same phone digits OR same email). */
export function matchPossibleDuplicate(incoming: Omit<Candidate, 'id'>, candidates: Candidate[]): PossibleDuplicate | null {
  const first = normalizeName(incoming.firstName), last = normalizeName(incoming.lastName)
  if (!first || !last) return null
  const phone = phoneDigits(incoming.phone), email = incoming.email.trim().toLowerCase()
  for (const c of candidates) {
    if (normalizeName(c.firstName) !== first || normalizeName(c.lastName) !== last) continue
    if (phone.length >= 7 && phoneDigits(c.phone) === phone) return { clientId: c.id, matchedOn: 'name+phone' }
    if (email && c.email.trim().toLowerCase() === email) return { clientId: c.id, matchedOn: 'name+email' }
  }
  return null
}

/**
 * Flag-only duplicate check for a freshly created SCS client. Never merges,
 * links ownership or deletes: it leaves an internal note on the new client
 * pointing at the earlier one so staff can decide.
 */
export async function flagPossibleDuplicate(
  store: Prisma.TransactionClient,
  client: Candidate & { organizationId: string },
): Promise<PossibleDuplicate | null> {
  const candidates = await store.client.findMany({
    where: {
      organizationId: client.organizationId,
      deletedAt: null,
      id: { not: client.id },
      firstName: { equals: client.firstName.trim(), mode: 'insensitive' },
      lastName: { equals: client.lastName.trim(), mode: 'insensitive' },
    },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true },
    orderBy: { createdAt: 'asc' },
    take: 20,
  })
  const hit = matchPossibleDuplicate(client, candidates)
  if (!hit) return null
  await store.note.create({
    data: {
      clientId: client.id,
      isInternal: true,
      body: `Possible duplicate of client ${hit.clientId} (matched on ${hit.matchedOn}). Not merged — review and merge manually if it is the same person: /clients/${hit.clientId}`,
    },
  })
  return hit
}
