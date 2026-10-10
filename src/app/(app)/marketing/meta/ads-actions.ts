'use server'

import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/rbac'
import {
  rematchLeadsCore, recheckConnectionCore, refreshAdsNowCore, setCycleLengthCore, startSpendCycleCore,
  type ManageResult,
} from '@/lib/meta/ads/manage'

/**
 * Server actions for the Meta Ads dashboard (docs/META_ADS_SCS.md §2.6).
 *
 * A Next action can be POSTed directly by its id from any page, so every
 * export gates itself, resolves the workspace from the session, and takes NO
 * workspace id or ad account id argument. The ad account always comes from the
 * server-side binding (META_ADS_ORG_ID + META_ALLOWED_AD_ACCOUNTS). The work
 * itself, the bound-workspace check and the audit row live in
 * src/lib/meta/ads/manage.ts, so there is one copy of each rule.
 */

export type AdsActionState = { ok?: string; error?: string }

const PAGE = '/marketing/meta'
/** The same dashboard under Call Center's Ads tab. */
const DESK = '/call-center'

async function run(core: (user: Awaited<ReturnType<typeof requirePermission>>) => Promise<ManageResult>, label: string): Promise<AdsActionState> {
  const user = await requirePermission('connectors:manage')
  let res: ManageResult
  try {
    res = await core(user)
  } catch (e) {
    console.error(`[meta-ads] ${label} failed`, e instanceof Error ? e.name : 'unknown')
    return { error: "Meta didn't answer as expected. Try again shortly." }
  }
  revalidatePath(PAGE); revalidatePath(DESK)
  return res.ok ? { ok: res.message } : { error: res.message }
}

/** Pull fresh numbers from Meta now. Limited to once every 2 minutes, counted in the DB. */
export async function refreshAdsNow(): Promise<AdsActionState> {
  return run(refreshAdsNowCore, 'manual refresh')
}

/** Close the open spend cycle and start the next one now. */
export async function startSpendCycle(): Promise<AdsActionState> {
  return run(startSpendCycleCore, 'start cycle')
}

/** Set the cycle length (1 to 90 days). Applies to the open cycle and every cycle after it. */
export async function setCycleLength(days: number): Promise<AdsActionState> {
  const n = typeof days === 'number' ? days : Number(days)
  return run((user) => setCycleLengthCore(user, n), 'cycle length')
}

/** Re-run the connection check (token, visible accounts, lead workspace) now. */
export async function recheckConnection(): Promise<AdsActionState> {
  return run(recheckConnectionCore, 'connection re-check')
}

/** Match recent Meta leads to ads again (stored attribution only; no lead reads from Meta). */
export async function rematchLeads(): Promise<AdsActionState> {
  return run(rematchLeadsCore, 'lead re-match')
}
