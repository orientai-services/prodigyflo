import type { Prisma } from '@prisma/client'
// Duplicate detection and merge rules. Pure where possible so the intake slice
// and unit tests can reuse them without a database.

export function normaliseEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase()
}

/** Last 10 digits — tolerates +1 prefixes and any formatting. */
export function normalisePhone(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '')
  return digits.length > 10 ? digits.slice(-10) : digits
}

function normaliseName(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

export type DuplicateQuery = {
  email?: string | null
  phone?: string | null
  firstName?: string | null
  lastName?: string | null
  postalCode?: string | null
}

export type DuplicateCandidate = {
  id: string
  firstName: string
  lastName: string
  email: string
  phone: string
  addresses?: { postalCode: string }[]
}

export type DuplicateMatch = {
  client: DuplicateCandidate
  matchedOn: 'email' | 'phone' | 'name_postal'
}

export type DuplicateResult = {
  /** Same email or same phone — treat as the same person. */
  exact: DuplicateMatch[]
  /** Same name and postal code — worth a human look. */
  possible: DuplicateMatch[]
}

/**
 * The minimal Prisma surface this needs, so tests can pass a stub. The arg is
 * `any` deliberately: the real PrismaClient's generic findMany signature is not
 * otherwise structurally assignable here.
 */
export type DedupeDb = {
  client: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<DuplicateCandidate[]>
  }
}

/**
 * Finds likely duplicates of an incoming person inside one organization.
 * Phone comparison happens in JS because stored numbers may be formatted;
 * the SQL side only prefilters on the last four digits.
 */
export async function findDuplicates(
  db: DedupeDb,
  organizationId: string,
  input: DuplicateQuery,
  opts: { excludeClientId?: string; scope?: Prisma.ClientWhereInput } = {},
): Promise<DuplicateResult> {
  const email = normaliseEmail(input.email)
  const phone = normalisePhone(input.phone)
  const firstName = normaliseName(input.firstName)
  const lastName = normaliseName(input.lastName)
  const postalCode = (input.postalCode ?? '').trim()

  const or: unknown[] = []
  if (email) or.push({ email: { equals: email, mode: 'insensitive' } })
  if (phone.length >= 4) or.push({ phone: { contains: phone.slice(-4) } })
  if (firstName && lastName && postalCode) {
    or.push({
      firstName: { equals: firstName, mode: 'insensitive' },
      lastName: { equals: lastName, mode: 'insensitive' },
      addresses: { some: { postalCode } },
    })
  }
  if (or.length === 0) return { exact: [], possible: [] }

  const candidates = await db.client.findMany({
    where: {
      organizationId,
      deletedAt: null,
      ...(opts.excludeClientId ? { id: { not: opts.excludeClientId } } : {}),
      OR: or,
      ...(opts.scope ? { AND: [opts.scope] } : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      addresses: { select: { postalCode: true } },
    },
    take: 20,
  })

  const exact: DuplicateMatch[] = []
  const possible: DuplicateMatch[] = []
  for (const c of candidates) {
    if (email && normaliseEmail(c.email) === email) {
      exact.push({ client: c, matchedOn: 'email' })
    } else if (phone && normalisePhone(c.phone) === phone) {
      exact.push({ client: c, matchedOn: 'phone' })
    } else if (
      firstName &&
      lastName &&
      postalCode &&
      normaliseName(c.firstName) === firstName &&
      normaliseName(c.lastName) === lastName &&
      (c.addresses ?? []).some((a) => a.postalCode === postalCode)
    ) {
      possible.push({ client: c, matchedOn: 'name_postal' })
    }
  }
  return { exact, possible }
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

/**
 * Merge an incoming partial record onto an existing one. An incoming empty
 * value NEVER erases existing data; an incoming non-empty value wins.
 * Returns only the keys that actually change, ready for an update payload.
 */
export function mergeIncoming<T extends Record<string, unknown>>(
  existing: T,
  incoming: Partial<T>,
): Partial<T> {
  const changes: Partial<T> = {}
  for (const key of Object.keys(incoming) as (keyof T)[]) {
    const next = incoming[key]
    if (isEmpty(next)) continue
    if (existing[key] === next) continue
    changes[key] = next
  }
  return changes
}
