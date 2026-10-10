import type { NextRequest } from 'next/server'
import { cronAuthorized } from '@/lib/cron-auth'
import { syncAllOrgs } from '@/lib/meta/ads/sync'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

/**
 * Meta Ads sync (docs/META_ADS_SCS.md §3.3). Hit by Vercel Cron every ten
 * minutes (vercel.json). Bearer CRON_SECRET or JOBS_TOKEN, checked first;
 * refuses everything when neither is set. Syncs only the bound workspace's
 * allowlisted ad accounts. The response holds counts only.
 */
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request, [process.env.JOBS_TOKEN])) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 })
  }
  const startedAt = Date.now()
  const result = await syncAllOrgs({ budgetMs: 240_000 })
  return Response.json({ ok: true, tookMs: Date.now() - startedAt, ...result })
}
