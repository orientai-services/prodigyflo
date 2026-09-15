/**
 * Bridge onto the shared CRM dedupe module (`@/lib/dedupe`, owned by the CRM
 * slice). Intake adds two policies on top:
 *  - the source's dedupeKeys decide which match kinds count and in what order
 *    (first hit wins); a kind the source disabled never merges, and the shared
 *    "possible" name+postal tier only counts when 'name' is explicitly enabled;
 *  - a throw makes the caller fall back to intake's own conservative matcher,
 *    so a webhook never 500s over a dedupe regression.
 */
import { findDuplicates, mergeIncoming, type DedupeDb } from '@/lib/dedupe'
import { db } from '@/lib/db'

export type DedupeInput = {
  organizationId: string
  email?: string
  phone?: string
  firstName?: string
  lastName?: string
  postalCode?: string
  dedupeKeys: string[]
}

export type DuplicateMatch = { clientId: string; matchedOn: string }

/** Source dedupe key -> the shared module's matchedOn value. */
const MATCH_KIND: Record<string, string> = { email: 'email', phone: 'phone', name: 'name_postal' }

/** Returns null when the shared implementation is unusable — caller falls back. */
export async function sharedFindDuplicates(input: DedupeInput, store: DedupeDb = db): Promise<DuplicateMatch[] | null> {
  try {
    // Reuse the caller's transaction: borrowing from the global pool here
    // stalls a one-connection pool until the owning transaction expires.
    const result = await findDuplicates(store, input.organizationId, {
      email: input.email ?? null,
      phone: input.phone ?? null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      postalCode: input.postalCode ?? null,
    })
    const all = [...result.exact, ...result.possible]
    for (const key of input.dedupeKeys) {
      const kind = MATCH_KIND[key]
      if (!kind) continue
      const hit = all.find((m) => m.matchedOn === kind)
      if (hit) return [{ clientId: hit.client.id, matchedOn: key }]
    }
    return []
  } catch {
    return null
  }
}

/**
 * The fields to write onto the existing client, or null when the shared merge
 * is unusable. Note: the shared rule lets a non-empty incoming value overwrite;
 * the intake caller additionally filters to blank-filling only, so unattended
 * webhook data can never clobber a value staff may have verified.
 */
export async function sharedMergeIncoming(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    const result = mergeIncoming(existing, incoming)
    if (typeof result !== 'object' || result === null || Array.isArray(result)) return null
    return result as Record<string, unknown>
  } catch {
    return null
  }
}
