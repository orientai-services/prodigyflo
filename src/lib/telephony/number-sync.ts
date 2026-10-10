import 'server-only'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import type { SessionUser } from '@/lib/rbac'
import { appOrigin, getTelephonyProvider, platformCredentials, webhooksFor } from './index'
import { ensureWallet } from './billing'
import { quoteNumber } from './pricing'
import { areaCodeOf, formatE164, type OwnedNumber, type TelephonyCredentials } from './provider'
import { credentialScope, guardAccountAction, isPlatformOwner, platformOrgId } from './tenancy'
import { readTelephonySettings, saveTelephonySettings } from './settings'
import type { SyncPreviewVM, SyncResultVM, SyncRowVM } from './voice-contract'

/**
 * Bringing numbers that already live at Twilio into the app (§4.4).
 *
 * The platform subaccount is SHARED by several organizations, so nothing here
 * may move a number across tenants:
 *
 *  - Platform account: only the platform owner previews and syncs, and only
 *    sid → org pairs the owner put in the assignment map are ever imported or
 *    repointed. Everything else shows as 'unassigned' and is left alone.
 *  - An org's own vault account: that org's telephony:manage holders, into
 *    that org only.
 *  - A number already on another org's row is never changed or moved.
 *  - Repointing the webhooks is opt-in per number, and pre-ticked only when
 *    the number points nowhere or already at this app.
 *  - Imports cost nothing today: monthly rent starts at the next renewal.
 *
 * Running it twice changes nothing the second time.
 */

export type SyncActor = { kind: 'user'; user: SessionUser } | { kind: 'script' }

type ExistingRow = { id: string; organizationId: string; status: string; providerSid: string | null; providerAccountSid: string | null; capabilities: unknown }

function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null
  }
}

function appHost(): string {
  return hostOf(appOrigin()) ?? ''
}

export function pointsHere(n: Pick<OwnedNumber, 'voiceUrl'>): boolean {
  return hostOf(n.voiceUrl) === appHost()
}

/** Pre-ticked for repoint: points nowhere, or already at this app. */
export function repointByDefault(n: Pick<OwnedNumber, 'voiceUrl'>): boolean {
  return !n.voiceUrl || pointsHere(n)
}

function masked(e164: string): string {
  const digits = e164.replace(/\D/g, '')
  return `•••-•••-${digits.slice(-4)}`
}

function rowState(
  n: OwnedNumber,
  existing: ExistingRow | undefined,
  targetOrg: string | null,
): SyncRowVM['state'] {
  if (!targetOrg) return 'unassigned'
  if (!existing) return 'new'
  if (existing.organizationId === targetOrg) return existing.status === 'RELEASED' ? 'released-here' : 'here'
  return existing.status === 'RELEASED' ? 'new' : 'other-account'
}

type Context = {
  scope: 'platform' | 'vault'
  creds: TelephonyCredentials
  /** sid → org the number belongs to (platform: the assignment map; vault: every sid → the vault org). */
  targetFor: (sid: string) => string | null
  viewerSeesAll: boolean
  viewerOrgId: string | null
  organizationName: string
}

async function contextFor(actor: SyncActor, organizationId?: string): Promise<{ ok: true; ctx: Context } | { ok: false; error: string; code: string }> {
  if (actor.kind === 'script') {
    const creds = platformCredentials()
    const platform = platformOrgId()
    if (!creds) return { ok: false, code: 'NOT_CONFIGURED', error: 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set.' }
    if (!platform) return { ok: false, code: 'NO_PLATFORM_OWNER', error: "Platform owner isn't configured." }
    const map = await assignmentMap()
    return {
      ok: true,
      ctx: { scope: 'platform', creds, targetFor: (sid) => map[sid] ?? null, viewerSeesAll: true, viewerOrgId: null, organizationName: 'Platform account' },
    }
  }
  const user = actor.user
  const orgId = organizationId ?? user.organizationId
  const guard = await guardAccountAction(user, orgId)
  if (!guard.ok) return guard
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { name: true } })
  if (guard.scope.kind === 'platform') {
    const map = await assignmentMap()
    return {
      ok: true,
      ctx: {
        scope: 'platform',
        creds: guard.scope.creds,
        targetFor: (sid) => map[sid] ?? null,
        viewerSeesAll: isPlatformOwner(user),
        viewerOrgId: user.organizationId,
        organizationName: org?.name ?? 'Platform account',
      },
    }
  }
  const vaultOrg = guard.scope.vaultOrgId
  return {
    ok: true,
    ctx: {
      scope: 'vault',
      creds: guard.scope.creds,
      targetFor: () => vaultOrg,
      viewerSeesAll: false,
      viewerOrgId: user.organizationId,
      organizationName: org?.name ?? 'This account',
    },
  }
}

/** settings.telephony.numberAssignments on the platform org. */
export async function assignmentMap(): Promise<Record<string, string>> {
  const platform = platformOrgId()
  if (!platform) return {}
  const org = await db.organization.findUnique({ where: { id: platform }, select: { settings: true } })
  return readTelephonySettings(org?.settings).numberAssignments
}

async function listCarrierNumbers(creds: TelephonyCredentials): Promise<{ ok: true; numbers: OwnedNumber[] } | { ok: false; error: string }> {
  const res = await getTelephonyProvider().listOwnedNumbers(creds)
  return res.ok ? { ok: true, numbers: res.numbers } : { ok: false, error: res.error }
}

async function existingByE164(e164s: string[]): Promise<Map<string, ExistingRow>> {
  if (e164s.length === 0) return new Map()
  const rows = await db.phoneNumber.findMany({
    where: { e164: { in: e164s } },
    select: { id: true, organizationId: true, status: true, providerSid: true, providerAccountSid: true, capabilities: true, e164: true },
  })
  return new Map(rows.map((r) => [r.e164, r]))
}

export async function previewNumberSync(
  actor: SyncActor,
  organizationId?: string,
): Promise<{ ok: true; preview: SyncPreviewVM } | { ok: false; error: string; code?: string }> {
  const c = await contextFor(actor, organizationId)
  if (!c.ok) return c
  const { ctx } = c
  const listed = await listCarrierNumbers(ctx.creds)
  if (!listed.ok) return { ok: false, code: 'CARRIER_ERROR', error: listed.error }

  const existing = await existingByE164(listed.numbers.map((n) => n.e164))
  const orgIds = [...new Set([...existing.values()].map((r) => r.organizationId).concat(listed.numbers.map((n) => ctx.targetFor(n.sid)).filter((v): v is string => Boolean(v))))]
  const orgs = await db.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } })
  const orgName = new Map(orgs.map((o) => [o.id, o.name]))

  const rows: SyncRowVM[] = listed.numbers.map((n) => {
    const row = existing.get(n.e164)
    const target = ctx.targetFor(n.sid)
    const state = rowState(n, row, target)
    const ownsIt = row && ctx.viewerOrgId && row.organizationId === ctx.viewerOrgId && row.status !== 'RELEASED'
    const full = ctx.viewerSeesAll || Boolean(ownsIt) || (ctx.scope === 'vault' && target === ctx.viewerOrgId)
    return {
      sid: n.sid,
      display: full ? formatE164(n.e164) : masked(n.e164),
      friendlyName: full ? n.friendlyName : '',
      state,
      assignedOrg: ctx.viewerSeesAll && target ? { id: target, name: orgName.get(target) ?? 'Unknown account' } : null,
      otherAccount:
        state === 'other-account' && row ? (ctx.viewerSeesAll ? orgName.get(row.organizationId) ?? 'another account' : 'another account') : null,
      voiceUrlHost: full ? hostOf(n.voiceUrl) : null,
      pointsHere: pointsHere(n),
      capabilities: n.capabilities,
    }
  })

  return { ok: true, preview: { account: maskAccount(ctx.creds.accountSid), platform: ctx.scope === 'platform', organizationName: ctx.organizationName, rows } }
}

export const OWN_ACCOUNT_REFUSED = 'That account uses its own Twilio account, so a platform number would not work there.'

/**
 * A platform number may only go to an org that rides the platform account. An
 * org with its own (or its agency's) Twilio in the vault would check the
 * line's webhooks and texts against the wrong account.
 */
async function ridesPlatform(organizationId: string): Promise<boolean> {
  const scope = await credentialScope(organizationId)
  return scope.kind === 'platform' || (scope.kind === 'none' && scope.reason === 'none')
}

export function maskAccount(sid: string): string {
  return sid.length > 8 ? `${sid.slice(0, 2)}…${sid.slice(-4)}` : sid
}

/** Platform owner: put a platform number in exactly one org (or take it out). */
export async function setNumberAssignment(
  user: SessionUser,
  input: { sid: string; organizationId: string | null },
): Promise<{ ok: true } | { ok: false; error: string; code?: string }> {
  const platform = platformOrgId()
  if (!platform) return { ok: false, code: 'NO_PLATFORM_OWNER', error: "Platform owner isn't configured." }
  if (!isPlatformOwner(user)) return { ok: false, code: 'PLATFORM_ONLY', error: 'Only the platform owner assigns numbers.' }
  if (!/^PN[0-9a-zA-Z]{32}$/.test(input.sid) && !/^PNMOCK\d+$/.test(input.sid)) {
    return { ok: false, code: 'BAD_SID', error: "That isn't a phone number SID." }
  }
  if (input.organizationId) {
    const org = await db.organization.findFirst({ where: { id: input.organizationId, deletedAt: null }, select: { id: true } })
    if (!org) return { ok: false, code: 'NOT_FOUND', error: 'That account does not exist.' }
    if (!(await ridesPlatform(org.id))) return { ok: false, code: 'OWN_ACCOUNT', error: OWN_ACCOUNT_REFUSED }
  }
  const map = await assignmentMap()
  const before = map[input.sid] ?? null
  const next = { ...map }
  if (input.organizationId) next[input.sid] = input.organizationId
  else delete next[input.sid]
  await saveTelephonySettings(platform, { numberAssignments: next })
  await recordAudit(user, {
    action: 'telephony.number_assigned',
    entityType: 'Organization',
    entityId: input.organizationId ?? platform,
    summary: `Platform number ${input.sid.slice(0, 6)}…${input.sid.slice(-4)} ${input.organizationId ? 'assigned' : 'unassigned'}`,
    before: { organizationId: before },
    after: { organizationId: input.organizationId },
  })
  return { ok: true }
}

function kindOf(e164: string): 'LOCAL' | 'TOLL_FREE' {
  const ac = areaCodeOf(e164)
  return ac && /^8(00|33|44|55|66|77|88)$/.test(ac) ? 'TOLL_FREE' : 'LOCAL'
}

async function audit(actor: SyncActor, organizationId: string, entry: { action: string; entityId: string; summary: string; after: Record<string, unknown> }) {
  try {
    if (actor.kind === 'user' && actor.user.organizationId === organizationId) {
      await recordAudit(actor.user, { action: entry.action, entityType: 'PhoneNumber', entityId: entry.entityId, summary: entry.summary, after: entry.after })
    } else {
      await db.auditEvent.create({
        data: {
          organizationId,
          actorId: actor.kind === 'user' ? actor.user.id : null,
          actorLabel: actor.kind === 'user' ? `${actor.user.name} (platform owner)` : 'Number sync script',
          action: entry.action,
          entityType: 'PhoneNumber',
          entityId: entry.entityId,
          summary: entry.summary,
          after: entry.after as never,
        },
      })
    }
  } catch {
    // An audit write never undoes an import.
  }
}

/** Import (or refresh) one carrier number into its org, in one transaction. Returns what changed. */
async function importOne(
  actor: SyncActor,
  n: OwnedNumber,
  targetOrg: string,
  existing: ExistingRow | undefined,
  accountSid: string,
  providerName: string,
  now: Date,
): Promise<'imported' | 'updated' | 'unchanged'> {
  const caps = n.capabilities as unknown as Prisma.InputJsonValue
  if (existing && existing.organizationId === targetOrg && existing.status !== 'RELEASED') {
    // Field by field: JSONB does not keep key order, so a string compare never matches.
    const stored = (existing.capabilities ?? {}) as Record<string, unknown>
    const same =
      existing.providerSid === n.sid &&
      existing.providerAccountSid === accountSid &&
      stored.voice === n.capabilities.voice &&
      stored.sms === n.capabilities.sms &&
      stored.mms === n.capabilities.mms
    if (same) return 'unchanged'
    await db.phoneNumber.update({
      where: { id: existing.id },
      data: { providerSid: n.sid, providerAccountSid: accountSid, capabilities: caps },
    })
    return 'updated'
  }

  const wallet = await ensureWallet(targetOrg)
  const kind = kindOf(n.e164)
  const quote = quoteNumber(kind)
  const next = new Date(now)
  next.setMonth(next.getMonth() + 1)
  const row = await db.$transaction(async (tx) => {
    const primary = await tx.phoneNumber.count({ where: { organizationId: targetOrg, isPrimary: true, status: { in: ['ACTIVE', 'PENDING'] } } })
    const data = {
      organizationId: targetOrg,
      friendlyName: n.friendlyName.slice(0, 80) || formatE164(n.e164),
      kind,
      status: 'ACTIVE' as const,
      isPrimary: primary === 0,
      areaCode: areaCodeOf(n.e164),
      provider: providerName,
      providerSid: n.sid,
      providerAccountSid: accountSid,
      capabilities: caps,
      importedAt: now,
      routing: 'VOICEMAIL_ONLY' as const,
      ringBrowsers: null,
      forwardTo: null,
      billingMode: wallet.billingMode,
      monthlyCostCents: quote.monthlyCents,
      setupCostCents: 0,
      nextRenewalAt: next,
      releasedAt: null,
    }
    return tx.phoneNumber.upsert({
      where: { e164: n.e164 },
      create: { e164: n.e164, ...data },
      update: data,
      select: { id: true },
    })
  })
  await audit(actor, targetOrg, {
    action: 'telephony.number_imported',
    entityId: row.id,
    summary: `Imported ${masked(n.e164)} from Twilio (no charge; rent starts at renewal)`,
    after: { sid: n.sid, routing: 'VOICEMAIL_ONLY' },
  })
  return 'imported'
}

export type ApplySyncInput = { organizationId?: string; importSids: string[]; repointSids: string[] }

export async function applyNumberSync(
  actor: SyncActor,
  input: ApplySyncInput,
  now = new Date(),
): Promise<{ ok: true; result: SyncResultVM } | { ok: false; error: string; code?: string }> {
  const c = await contextFor(actor, input.organizationId)
  if (!c.ok) return c
  const { ctx } = c
  if (ctx.scope === 'platform' && actor.kind === 'user' && !ctx.viewerSeesAll) {
    return { ok: false, code: 'PLATFORM_ONLY', error: 'Number sync for the shared account is done by the platform owner.' }
  }
  const listed = await listCarrierNumbers(ctx.creds)
  if (!listed.ok) return { ok: false, code: 'CARRIER_ERROR', error: listed.error }

  const provider = getTelephonyProvider()
  const bySid = new Map(listed.numbers.map((n) => [n.sid, n]))
  const existing = await existingByE164(listed.numbers.map((n) => n.e164))
  const result: SyncResultVM = { imported: 0, updated: 0, repointed: 0, skipped: [] }
  const importSet = new Set(input.importSids)
  const platformTarget = new Map<string, boolean>()

  for (const sid of new Set([...input.importSids, ...input.repointSids])) {
    const n = bySid.get(sid)
    if (!n) {
      result.skipped.push({ sid, reason: 'Not on this Twilio account.' })
      continue
    }
    const target = ctx.targetFor(sid)
    const row = existing.get(n.e164)
    const state = rowState(n, row, target)
    if (state === 'unassigned' || !target) {
      result.skipped.push({ sid, reason: 'Assign to an account first.' })
      continue
    }
    if (state === 'other-account') {
      result.skipped.push({ sid, reason: 'On another account here. Not changed.' })
      continue
    }
    if (ctx.scope === 'platform') {
      if (!platformTarget.has(target)) platformTarget.set(target, await ridesPlatform(target))
      if (!platformTarget.get(target)) {
        result.skipped.push({ sid, reason: OWN_ACCOUNT_REFUSED })
        continue
      }
    }
    if (importSet.has(sid)) {
      const outcome = await importOne(actor, n, target, row, ctx.creds.accountSid, provider.name, now)
      if (outcome === 'imported') result.imported += 1
      if (outcome === 'updated') result.updated += 1
    }
    if (input.repointSids.includes(sid)) {
      const hooks = webhooksFor()
      const already =
        n.voiceUrl === hooks.voiceUrl &&
        n.smsUrl === hooks.smsUrl &&
        n.statusCallback === hooks.voiceStatusUrl &&
        (n.voiceFallbackUrl ?? undefined) === hooks.voiceFallbackUrl
      if (already) continue
      const res = await provider.updateWebhooks(sid, hooks, ctx.creds)
      if (!res.ok) {
        result.skipped.push({ sid, reason: `Twilio refused the update: ${res.error}` })
        continue
      }
      result.repointed += 1
      const updated = await db.phoneNumber.findUnique({ where: { e164: n.e164 }, select: { id: true } })
      if (updated) {
        await db.phoneNumber.update({ where: { id: updated.id }, data: { webhookDrift: Prisma.DbNull, webhookCheckedAt: now } })
      }
      await audit(actor, target, {
        action: 'telephony.number_repointed',
        entityId: updated?.id ?? sid,
        summary: `Pointed ${masked(n.e164)} at this app`,
        after: { sid, voiceUrlHost: hostOf(hooks.voiceUrl) },
      })
    }
  }
  return { ok: true, result }
}

/**
 * The script's whole job (scripts/telephony-sync-numbers.ts): platform env
 * credentials only; import only assigned sid → org pairs; with `repoint`,
 * repoint only numbers that point nowhere or already here. Dry run writes
 * nothing.
 */
export async function syncNumbersForScript(opts: { execute: boolean; repoint: boolean }, now = new Date()) {
  const actor: SyncActor = { kind: 'script' }
  const preview = await previewNumberSync(actor)
  if (!preview.ok) return preview
  const listed = await listCarrierNumbers(platformCredentials()!)
  const bySid = new Map(listed.ok ? listed.numbers.map((n) => [n.sid, n]) : [])
  const importSids = preview.preview.rows.filter((r) => r.state === 'new' || r.state === 'released-here' || r.state === 'here').map((r) => r.sid)
  const repointSids = opts.repoint
    ? preview.preview.rows.filter((r) => r.state !== 'unassigned' && r.state !== 'other-account' && bySid.get(r.sid) && repointByDefault(bySid.get(r.sid)!)).map((r) => r.sid)
    : []
  if (!opts.execute) return { ok: true as const, dryRun: true, preview: preview.preview, wouldImport: importSids, wouldRepoint: repointSids }
  const applied = await applyNumberSync(actor, { importSids, repointSids }, now)
  if (!applied.ok) return applied
  return { ok: true as const, dryRun: false, preview: preview.preview, result: applied.result }
}

/** For the sweep: what differs between Twilio's webhooks and ours (null = nothing). */
export function webhookDriftOf(n: OwnedNumber): Record<string, string | null> | null {
  const hooks = webhooksFor()
  const drift: Record<string, string | null> = {}
  if (n.voiceUrl !== hooks.voiceUrl) drift.voiceUrl = n.voiceUrl
  if (n.smsUrl !== hooks.smsUrl) drift.smsUrl = n.smsUrl
  if (n.statusCallback !== hooks.voiceStatusUrl) drift.statusCallback = n.statusCallback
  if (hooks.voiceFallbackUrl && n.voiceFallbackUrl !== hooks.voiceFallbackUrl) drift.voiceFallbackUrl = n.voiceFallbackUrl
  return Object.keys(drift).length ? drift : null
}

