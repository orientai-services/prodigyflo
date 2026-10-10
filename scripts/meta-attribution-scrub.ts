/**
 * P0-A backfill (docs/META_ADS_SCS.md §3.9). Dry run unless --commit.
 *
 * Earlier intake stored Graph-supplied ad, ad set and campaign NAMES on Meta
 * leads, whichever ad account the ad belonged to, and linked leads to local
 * campaigns with no allowlist. This removes every copy of a name that isn't an
 * allowed campaign's:
 *  - adName / adsetName / campaignName in Client.leadAttribution and
 *    CallCenterLead.leadAttribution (ids stay);
 *  - utm_campaign / utmCampaign in EVERY IntakeSubmission of a Meta Lead Ads
 *    source (any status, with or without a client), unless the value is the
 *    name or utmCampaign of an allowed local campaign;
 *  - Client.utmCampaign when it equals a value removed above, the client's own
 *    stored campaign name, or the name/utmCampaign of a hidden (non-allowed)
 *    Meta campaign the client is linked to;
 *  - for clients linked to a hidden Meta campaign: the campaign name in the
 *    pinned Instant Lead Ignition note, and `campaign` on meta.lead_ignited
 *    audit rows;
 *  - utmCampaign in the `after` of intake.client_matched / intake.client_created
 *    audit rows written by a Meta Lead Ads source.
 *
 * Covers every workspace. Prints counts only, never names. Idempotent.
 *
 *   npx tsx --conditions=react-server scripts/meta-attribution-scrub.ts [--commit]
 */
import 'dotenv/config'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { allowedAccountsForOrg } from '@/lib/meta/ads/allowlist'
import { allowedMetaOnlyCampaignWhere } from '@/lib/meta/ads/where'

const NAME_KEYS = ['adName', 'adsetName', 'campaignName'] as const
const IGNITION_PREFIX = '⚡ Instant Lead Ignition'
const INTAKE_AUDIT_ACTIONS = ['intake.client_matched', 'intake.client_created']
const BATCH = 500

export type ScrubCounts = {
  clientsNamed: number
  callCenterNamed: number
  clientUtmCleared: number
  submissionsCleared: number
  notesCleared: number
  auditRowsCleared: number
  /** Rows still carrying a name that isn't an allowed campaign's (after a commit this is 0). */
  named: number
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const hasName = (a: Obj) => NAME_KEYS.some((k) => typeof a[k] === 'string' && (a[k] as string).length > 0)
const stripNames = (a: Obj): Obj => ({ ...a, adName: null, adsetName: null, campaignName: null })
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/** Names and utmCampaigns of this workspace's allowed (synced, approved-account) Meta campaigns. */
async function allowedValues(orgId: string): Promise<Set<string>> {
  const rows = await db.campaign.findMany({ where: allowedMetaOnlyCampaignWhere(orgId), select: { name: true, utmCampaign: true } })
  const out = new Set<string>()
  for (const r of rows) {
    out.add(r.name)
    if (r.utmCampaign) out.add(r.utmCampaign)
  }
  return out
}

/** Remove every utm_campaign value in a payload pair that isn't allowed. */
export function scrubPayloads(raw: Obj, mapped: Obj, allowed: ReadonlySet<string>): { raw: Obj; mapped: Obj; removed: string[] } {
  const removed: string[] = []
  const nextRaw = { ...raw }
  const nextMapped = { ...mapped }
  const check = (o: Obj, key: string) => {
    const v = str(o[key])
    if (v !== null && !allowed.has(v)) {
      removed.push(v)
      delete o[key]
    }
  }
  check(nextRaw, 'utm_campaign')
  check(nextMapped, 'utmCampaign')
  check(nextMapped, 'utm_campaign')
  return { raw: nextRaw, mapped: nextMapped, removed }
}

/** Take a hidden campaign's name out of an Instant Lead Ignition note body. */
export function scrubIgnitionBody(body: string, name: string): string {
  if (!name) return body
  return body.split(` (${name})`).join('').split(` about ${name}`).join('').split(` sobre ${name}`).join('')
}

async function scrubOrg(orgId: string, commit: boolean, counts: ScrubCounts): Promise<void> {
  const allowed = await allowedValues(orgId)
  const allowedAccounts = allowedAccountsForOrg(orgId)

  // 1. Every Meta Lead Ads submission, any status, with or without a client.
  const sources = await db.intakeSource.findMany({ where: { organizationId: orgId, kind: 'META_LEAD_ADS' }, select: { id: true, name: true } })
  const removedByClient = new Map<string, Set<string>>()
  if (sources.length) {
    let cursor: string | undefined
    for (;;) {
      const subs = await db.intakeSubmission.findMany({
        where: { organizationId: orgId, sourceId: { in: sources.map((s) => s.id) } },
        select: { id: true, clientId: true, rawPayload: true, mappedPayload: true },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      })
      if (subs.length === 0) break
      cursor = subs[subs.length - 1].id
      for (const s of subs) {
        const r = scrubPayloads(isObj(s.rawPayload) ? s.rawPayload : {}, isObj(s.mappedPayload) ? s.mappedPayload : {}, allowed)
        if (r.removed.length === 0) continue
        counts.submissionsCleared++
        if (s.clientId) {
          const set = removedByClient.get(s.clientId) ?? new Set<string>()
          for (const v of r.removed) set.add(v)
          removedByClient.set(s.clientId, set)
        }
        if (commit) {
          await db.intakeSubmission.update({ where: { id: s.id }, data: { rawPayload: r.raw as Prisma.InputJsonValue, mappedPayload: r.mapped as Prisma.InputJsonValue } })
        }
      }
      if (subs.length < BATCH) break
    }
  }

  // 2. Clients: stored names, utm_campaign copies, and links to hidden Meta campaigns.
  const hiddenCampaign: Prisma.CampaignWhereInput = {
    channel: 'meta',
    OR: [{ adAccountId: null }, { adAccountId: { notIn: allowedAccounts } }],
  }
  const clients = await db.client.findMany({
    where: {
      organizationId: orgId,
      OR: [
        { leadAttribution: { path: ['provider'], equals: 'meta' } },
        { id: { in: [...removedByClient.keys()] } },
        { campaign: hiddenCampaign },
      ],
    },
    select: {
      id: true, leadAttribution: true, utmCampaign: true,
      campaign: { select: { name: true, utmCampaign: true, channel: true, adAccountId: true } },
    },
  })
  for (const c of clients) {
    const a = isObj(c.leadAttribution) && c.leadAttribution.provider === 'meta' ? c.leadAttribution : null
    const named = Boolean(a && hasName(a))
    if (named) counts.clientsNamed++

    const hidden = c.campaign && c.campaign.channel === 'meta' && (c.campaign.adAccountId === null || !allowedAccounts.includes(c.campaign.adAccountId))
      ? c.campaign
      : null
    const foreign = new Set<string>(removedByClient.get(c.id) ?? [])
    const storedName = a ? str(a.campaignName) : null
    if (storedName) foreign.add(storedName)
    if (hidden) {
      foreign.add(hidden.name)
      if (hidden.utmCampaign) foreign.add(hidden.utmCampaign)
    }
    const clearUtm = Boolean(c.utmCampaign && foreign.has(c.utmCampaign) && !allowed.has(c.utmCampaign))
    if (clearUtm) counts.clientUtmCleared++

    // Legacy link to a hidden campaign: ignition note and its audit row.
    const noteUpdates: { id: string; body: string }[] = []
    const auditUpdates: { id: string; after: Obj }[] = []
    if (hidden && !allowed.has(hidden.name)) {
      const notes = await db.note.findMany({
        where: { clientId: c.id, authorId: null, pinned: true, body: { startsWith: IGNITION_PREFIX } },
        select: { id: true, body: true },
      })
      for (const n of notes) {
        const body = scrubIgnitionBody(n.body, hidden.name)
        if (body !== n.body) noteUpdates.push({ id: n.id, body })
      }
      const ignited = await db.auditEvent.findMany({
        where: { organizationId: orgId, action: 'meta.lead_ignited', entityType: 'Client', entityId: c.id },
        select: { id: true, after: true },
      })
      for (const e of ignited) {
        if (isObj(e.after) && e.after.campaign === hidden.name) auditUpdates.push({ id: e.id, after: { ...e.after, campaign: null } })
      }
    }
    counts.notesCleared += noteUpdates.length
    counts.auditRowsCleared += auditUpdates.length

    if (!commit || (!named && !clearUtm && noteUpdates.length === 0 && auditUpdates.length === 0)) continue
    await db.$transaction([
      ...(named || clearUtm
        ? [db.client.update({
            where: { id: c.id },
            data: { ...(named ? { leadAttribution: stripNames(a!) as Prisma.InputJsonValue } : {}), ...(clearUtm ? { utmCampaign: null } : {}) },
          })]
        : []),
      ...noteUpdates.map((n) => db.note.update({ where: { id: n.id }, data: { body: n.body } })),
      ...auditUpdates.map((u) => db.auditEvent.update({ where: { id: u.id }, data: { after: u.after as Prisma.InputJsonValue } })),
    ])
  }

  // 3. Intake audit rows written by a Meta Lead Ads source.
  if (sources.length) {
    const fromMeta = (summary: string) => sources.some((s) => summary.includes(`"${s.name}"`))
    const events = await db.auditEvent.findMany({
      where: { organizationId: orgId, action: { in: INTAKE_AUDIT_ACTIONS }, entityType: 'Client' },
      select: { id: true, summary: true, after: true },
    })
    for (const e of events) {
      if (!isObj(e.after) || !fromMeta(e.summary ?? '')) continue
      const v = str(e.after.utmCampaign)
      if (v === null || allowed.has(v)) continue
      counts.auditRowsCleared++
      if (commit) {
        const next = { ...e.after }
        delete next.utmCampaign
        await db.auditEvent.update({ where: { id: e.id }, data: { after: next as Prisma.InputJsonValue } })
      }
    }
  }
}

export async function scrubAttribution(opts: { commit?: boolean; log?: (line: string) => void } = {}): Promise<ScrubCounts> {
  const log = opts.log ?? (() => {})
  const commit = Boolean(opts.commit)
  const counts: ScrubCounts = { clientsNamed: 0, callCenterNamed: 0, clientUtmCleared: 0, submissionsCleared: 0, notesCleared: 0, auditRowsCleared: 0, named: 0 }

  const orgs = await db.organization.findMany({ select: { id: true } })
  for (const o of orgs) await scrubOrg(o.id, commit, counts)

  const leads = await db.callCenterLead.findMany({ where: { leadAttribution: { path: ['provider'], equals: 'meta' } }, select: { id: true, leadAttribution: true } })
  for (const l of leads) {
    const a = l.leadAttribution
    if (!isObj(a) || !hasName(a)) continue
    counts.callCenterNamed++
    if (commit) await db.callCenterLead.update({ where: { id: l.id }, data: { leadAttribution: stripNames(a) as Prisma.InputJsonValue } })
  }

  counts.named = commit
    ? 0
    : counts.clientsNamed + counts.callCenterNamed + counts.clientUtmCleared + counts.submissionsCleared + counts.notesCleared + counts.auditRowsCleared
  log(
    `${commit ? 'Scrubbed' : 'Would scrub'}: clients with names ${counts.clientsNamed}, call center leads with names ${counts.callCenterNamed}, ` +
    `client utm_campaign cleared ${counts.clientUtmCleared}, intake submissions cleared ${counts.submissionsCleared}, ` +
    `ignition notes cleared ${counts.notesCleared}, audit rows cleared ${counts.auditRowsCleared}.`,
  )
  if (!commit) log('Dry run. Nothing was changed. Re-run with --commit to apply.')
  return counts
}

/** Rows that still carry a name (used by the connect script's --commit gate). */
export async function countNamedAttributionRows(): Promise<number> {
  return (await scrubAttribution({ commit: false })).named
}

const isMain = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/meta-attribution-scrub.ts')
if (isMain) {
  scrubAttribution({ commit: process.argv.includes('--commit'), log: (l) => console.log(l) })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : 'Scrub failed.')
      process.exit(1)
    })
}
