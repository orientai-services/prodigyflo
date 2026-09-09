import { timingSafeEqual } from 'node:crypto'

export function bearerToken(req: { headers: { get(name: string): string | null } }): string {
  const header = req.headers.get('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

export function bearerMatches(presented: string, secrets: Array<string | undefined>): boolean {
  if (!presented) return false
  const a = Buffer.from(presented)
  for (const secret of secrets) {
    if (!secret) continue
    const b = Buffer.from(secret)
    if (a.length === b.length && timingSafeEqual(a, b)) return true
  }
  return false
}

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when that env is set.
 * App-specific secrets (JOBS_TOKEN, …) are accepted as extras so droplet timers
 * and Vercel Cron can coexist.
 */
export function cronAuthorized(
  req: { headers: { get(name: string): string | null } },
  extra: Array<string | undefined> = [],
): boolean {
  return bearerMatches(bearerToken(req), [process.env.CRON_SECRET, ...extra])
}
