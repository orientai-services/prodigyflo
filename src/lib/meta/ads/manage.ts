import 'server-only'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { can, ForbiddenError, type SessionUser } from '@/lib/rbac'
import { resolveAdsConfig } from './config'
import { MetaGraphError } from './graph-client'
import { clampCycleDays, finalAfter, KEEP_CLOSED_CYCLES } from './cycle'
import { adsSourceFor, syncAdsForOrg } from './sync'
import { rebuildLeadTouches, resetUnmatchedTouches } from './touches'

/**
 * The operations behind the /marketing/meta server actions (docs §2.6). The
 * workspace always comes from the session; no function here accepts a
 * workspace id or an ad account id. Every one requires connectors:manage and
 * writes an audit row. The UI's actions add requirePermission + revalidatePath.
 */

export type ManageResult = { ok: true; message: string } | { ok: false; message: string }

const NOT_HERE = "Meta Ads reporting isn't connected for this workspace."
const MANUAL_GAP_MS = 2 * 60_000

async function accountFor(user: SessionUser) {
  if (!can(user, 'connectors:manage')) throw new ForbiddenError()
  const config = await resolveAdsConfig(user.organizationId)
  if (config.mode === 'not_connected' || !config.adAccountId) return null
  const row = await db.metaAdAccount.findFirst({ where: { organizationId: user.organizationId, adAccountId: config.adAccountId } })
  return { config, row, account: config.adAccountId }
}

/**
 * Sample mode only (development and preview, never production): the cron syncs
 * live accounts only, so the first page view fills the sample account itself.
 * No network call: the mock source is deterministic. A no-op in every other
 * mode, and once the sample account has had a full sync.
 */
export async function ensureSampleAdsData(user: SessionUser): Promise<boolean> {
  if (!can(user, 'connectors:read')) return false
  const config = await resolveAdsConfig(user.organizationId)
  if (config.mode !== 'mock' || !config.adAccountId) return false
  const row = await db.metaAdAccount.findFirst({
    where: { organizationId: user.organizationId, adAccountId: config.adAccountId },
    select: { lastFullSyncAt: true },
  })
  if (row?.lastFullSyncAt) return false
  const [r] = await syncAdsForOrg(user.organizationId, { force: true })
  return Boolean(r && !('skipped' in r) && !r.error)
}

/** "Refresh now": at most once every 2 minutes per account, enforced in the database. */
export async function refreshAdsNowCore(user: SessionUser): Promise<ManageResult> {
  const ctx = await accountFor(user)
  if (!ctx) return { ok: false, message: NOT_HERE }
  if (!ctx.row) {
    // First run creates the row through the sync itself.
    const [r] = await syncAdsForOrg(user.organizationId, { force: true, manual: true })
    await recordAudit(user, { action: 'meta.ads.refreshed', entityType: 'MetaAdAccount', summary: 'Manual refresh' })
    return r && !('skipped' in r) && !r.error ? { ok: true, message: 'Refreshed.' } : { ok: false, message: "Couldn't refresh right now." }
  }
  const now = new Date()
  if (ctx.row.syncLeaseUntil && ctx.row.syncLeaseUntil > now) return { ok: false, message: 'Already refreshing.' }
  const claimed = await db.metaAdAccount.updateMany({
    where: {
      id: ctx.row.id,
      OR: [{ lastManualRefreshAt: null }, { lastManualRefreshAt: { lt: new Date(now.getTime() - MANUAL_GAP_MS) } }],
    },
    data: { lastManualRefreshAt: now },
  })
  if (claimed.count === 0) return { ok: false, message: 'Refreshed a moment ago. Try again in a couple of minutes.' }
  const [r] = await syncAdsForOrg(user.organizationId, { force: true, manual: true })
  await recordAudit(user, { action: 'meta.ads.refreshed', entityType: 'MetaAdAccount', entityId: ctx.row.id, summary: 'Manual refresh' })
  if (!r || 'skipped' in r) return { ok: false, message: r && 'skipped' in r && r.skipped === 'busy' ? 'Already refreshing.' : "Couldn't refresh right now." }
  if (r.error) return { ok: false, message: 'Meta had a problem. The last good numbers are still shown.' }
  return { ok: true, message: 'Refreshed.' }
}

/** Close the open cycle and start number+1 now. A double click gets a clean error. */
export async function startSpendCycleCore(user: SessionUser): Promise<ManageResult> {
  const ctx = await accountFor(user)
  if (!ctx) return { ok: false, message: NOT_HERE }
  const orgId = user.organizationId
  const account = ctx.account
  const lengthDays = ctx.row?.cycleDays ?? 15
  const now = new Date()
  try {
    const created = await db.$transaction(async (tx) => {
      const open = await tx.$queryRaw<{ id: string; number: number }[]>`
        SELECT "id", "number" FROM "MetaSpendCycle"
        WHERE "adAccountId" = ${account} AND "organizationId" = ${orgId} AND "endedAt" IS NULL
        ORDER BY "number" DESC FOR UPDATE`
      const last = await tx.metaSpendCycle.findFirst({ where: { organizationId: orgId, adAccountId: account }, orderBy: { number: 'desc' }, select: { number: true } })
      for (const o of open) {
        await tx.metaSpendCycle.update({ where: { id: o.id }, data: { endedAt: now, finalAfter: finalAfter(now) } })
      }
      return tx.metaSpendCycle.create({
        data: { organizationId: orgId, adAccountId: account, number: (last?.number ?? 0) + 1, lengthDays, startedAt: now, startedById: user.id },
      })
    })
    // Keep the last 24 closed cycles.
    const old = await db.metaSpendCycle.findMany({
      where: { organizationId: orgId, adAccountId: account, endedAt: { not: null } },
      orderBy: { number: 'desc' }, skip: KEEP_CLOSED_CYCLES, select: { id: true },
    })
    if (old.length) await db.metaSpendCycle.deleteMany({ where: { id: { in: old.map((o) => o.id) } } })
    await recordAudit(user, { action: 'meta.cycle.started', entityType: 'MetaSpendCycle', entityId: created.id, summary: `Cycle ${created.number} started (${lengthDays} days)` })
    return { ok: true, message: `Cycle ${created.number} started.` }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { ok: false, message: 'A new cycle was just started.' }
    throw e
  }
}

export async function setCycleLengthCore(user: SessionUser, days: number): Promise<ManageResult> {
  const v = clampCycleDays(days)
  if (v === null) return { ok: false, message: 'Pick a length from 1 to 90 days.' }
  const ctx = await accountFor(user)
  if (!ctx) return { ok: false, message: NOT_HERE }
  if (!ctx.row) return { ok: false, message: 'Wait for the first sync, then set the cycle length.' }
  // Applies to the cycle running now and every cycle after it.
  await db.$transaction([
    db.metaAdAccount.update({ where: { id: ctx.row.id }, data: { cycleDays: v } }),
    db.metaSpendCycle.updateMany({ where: { organizationId: user.organizationId, adAccountId: ctx.account, endedAt: null }, data: { lengthDays: v } }),
  ])
  await recordAudit(user, { action: 'meta.cycle.length_changed', entityType: 'MetaAdAccount', entityId: ctx.row.id, summary: `Cycle length → ${v} days` })
  return { ok: true, message: `Cycles now last ${v} days.` }
}

export async function recheckConnectionCore(user: SessionUser): Promise<ManageResult> {
  const ctx = await accountFor(user)
  if (!ctx) return { ok: false, message: NOT_HERE }
  const [r] = await syncAdsForOrg(user.organizationId, { recheck: true })
  await recordAudit(user, { action: 'meta.ads.rechecked', entityType: 'MetaAdAccount', entityId: ctx.row?.id ?? null, summary: 'Connection re-check' })
  if (!r || 'skipped' in r) return { ok: false, message: r && 'skipped' in r && r.skipped === 'busy' ? 'A sync is running. Try again in a minute.' : "Couldn't check right now." }
  return r.error ? { ok: false, message: 'Meta had a problem. See the errors below.' } : { ok: true, message: 'Checked.' }
}

export async function rematchLeadsCore(user: SessionUser): Promise<ManageResult> {
  const ctx = await accountFor(user)
  if (!ctx) return { ok: false, message: NOT_HERE }
  const reset = await resetUnmatchedTouches(user.organizationId)
  const source = await adsSourceFor(user.organizationId)
  let r: Awaited<ReturnType<typeof rebuildLeadTouches>>
  try {
    r = await rebuildLeadTouches(user.organizationId, { accounts: [ctx.account], source, limit: 500, probes: 50 })
  } catch (e) {
    // Rate, token or block errors stop the probes. The reset leads stay pending
    // and the regular sync finishes them.
    if (!(e instanceof MetaGraphError)) throw e
    await recordAudit(user, { action: 'meta.leads.rematched', entityType: 'MetaLeadTouch', summary: `Re-match stopped early (${reset} reset)` })
    return { ok: false, message: `${e.kind === 'rate' ? 'Meta asked us to slow down.' : e.plain} The rest are matched on the next sync.` }
  }
  await recordAudit(user, { action: 'meta.leads.rematched', entityType: 'MetaLeadTouch', summary: `Re-matched ${r.scanned} leads (${reset} reset)` })
  return { ok: true, message: `Checked ${r.scanned} leads: ${r.matched} matched, ${r.pending} still being checked.` }
}
