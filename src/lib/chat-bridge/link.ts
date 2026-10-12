import 'server-only'

/**
 * ProdigyFlo user ↔ SunOff user, the one identity the chat knows
 * (docs/CYS_BRIDGE.md §F D2: each PF staff user maps to their existing SunOff
 * user; if none exists, a provision call creates one and emails them).
 *
 * Local adapter: lane handoff owns the real link (pf_user_link + the provision
 * call, in src/lib/call-center/sunoff-actions.ts). Until that lands, links come
 * from CHAT_USER_LINKS, a JSON object {"<pf user id>": <SunOff user id>} the
 * owner sets in the environment. The integrator swaps the three functions below
 * for lane handoff's; nothing else in the chat bridge reads a link directly.
 */

function envLinks(): Map<string, number> {
  const out = new Map<string, number>()
  try {
    const raw = JSON.parse(process.env.CHAT_USER_LINKS ?? '{}') as Record<string, unknown>
    for (const [pfUserId, sunoffId] of Object.entries(raw ?? {})) {
      const n = Number(sunoffId)
      if (/^[A-Za-z0-9_-]{1,64}$/.test(pfUserId) && Number.isInteger(n) && n > 0) out.set(pfUserId, n)
    }
  } catch {
    // A malformed value links nobody.
  }
  return out
}

/** The SunOff user id linked to this ProdigyFlo user, or null. */
export async function sunoffUserIdFor(pfUserId: string): Promise<number | null> {
  return envLinks().get(pfUserId) ?? null
}

/** Reverse lookup for requests coming from the chat (case-sms names a uid). */
export async function pfUserIdForSunoff(sunoffUserId: number): Promise<string | null> {
  const hits = [...envLinks()].filter(([, id]) => id === sunoffUserId).map(([pf]) => pf)
  // Two PF users on one SunOff account would make every chat action ambiguous: refuse.
  return hits.length === 1 ? hits[0] : null
}

/** Every linked pair, for the case feed (who is a rep / watcher in the chat). */
export async function linkedUsers(): Promise<Map<string, number>> {
  return envLinks()
}

export type ProvisionResult = { ok: true; sunoffUserId: number; created: boolean } | { ok: false; error: string }

/** "Link your SunOff account": lane handoff's provisionSunoffUser() replaces this. */
export async function provisionLink(pfUserId: string): Promise<ProvisionResult> {
  const existing = await sunoffUserIdFor(pfUserId)
  if (existing) return { ok: true, sunoffUserId: existing, created: false }
  return { ok: false, error: 'Linking from here isn’t switched on yet. Ask the owner to link your SunOff account.' }
}
