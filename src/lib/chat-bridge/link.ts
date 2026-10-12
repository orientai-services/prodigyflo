import 'server-only'
import type { SessionUser } from '@/lib/rbac'
import { loadActor } from '@/lib/automation/actor'

/**
 * ProdigyFlo user → SunOff user, the one identity the chat knows
 * (docs/CYS_BRIDGE.md §F D2). ProdigyFlo stores no link: SunOff's
 * pf_user_link is the only store, read through lane handoff's server-only
 * `sunoffUserIdFor(user)` (one signed round trip, match only, never creates).
 * The lookup is forward only, so every chat path starts from a ProdigyFlo
 * user: the token from the signed-in user, case-sms from the PF user id the
 * chat sends back (and checks it maps to the uid it claims), the case feed
 * from the lead's holder / owner / Super Admins.
 *
 * INTEGRATION (once feat/cys-handoff is merged): replace `envLookup` with
 *   import { sunoffUserIdFor } from '@/lib/sunoff-bridge/handoff'
 * and `provisionLink` with a call to provisionSunoffUser() from
 *   '@/lib/call-center/sunoff-actions' (it returns `reason`, not `error`).
 * Until then links come from CHAT_USER_LINKS, a JSON object
 * {"<pf user id>": <SunOff user id>} the owner may set.
 */

async function envLookup(user: SessionUser): Promise<number | null> {
  try {
    const raw = JSON.parse(process.env.CHAT_USER_LINKS ?? '{}') as Record<string, unknown>
    const n = Number(raw?.[user.id])
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

const lookup: (user: SessionUser) => Promise<number | null> = envLookup

// The real lookup is a signed call to SunOff per user: cache hits 5 minutes, misses 1 minute (per server instance).
const HIT_MS = 5 * 60_000
const MISS_MS = 60_000
const cache = new Map<string, { id: number | null; at: number }>()

export async function linkedSunoffId(user: SessionUser, now = Date.now()): Promise<number | null> {
  const hit = cache.get(user.id)
  if (hit && now - hit.at < (hit.id ? HIT_MS : MISS_MS)) return hit.id
  const id = await lookup(user).catch(() => null)
  if (cache.size > 2000) cache.clear()
  cache.set(user.id, { id, at: now })
  return id
}

/** For callers that only hold a user id (the case feed, case-sms). Inactive or non-staff users have no link. */
export async function linkedSunoffIdById(pfUserId: string): Promise<{ user: SessionUser; sunoffUserId: number } | null> {
  const user = await loadActor(pfUserId)
  if (!user) return null
  const sunoffUserId = await linkedSunoffId(user)
  return sunoffUserId ? { user, sunoffUserId } : null
}

/** Tests only: forget cached links. */
export function clearLinkCache(): void {
  cache.clear()
}

export type ProvisionResult = { ok: true; sunoffUserId: number | null; created: boolean } | { ok: false; error: string }

/** "Link your SunOff account": lane handoff's provisionSunoffUser() replaces the body (see INTEGRATION above). */
export async function provisionLink(user: SessionUser): Promise<ProvisionResult> {
  cache.delete(user.id)
  const existing = await linkedSunoffId(user)
  if (existing) return { ok: true, sunoffUserId: existing, created: false }
  return { ok: false, error: 'Linking from here isn’t switched on yet. Ask the owner to link your SunOff account.' }
}
