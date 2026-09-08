import 'server-only'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import type { SessionUser } from '@/lib/rbac'
import { currency } from '@/lib/format'
import { getMetaProviderFor } from './index'
import type { ConsoleCommand } from './console'
import { CONSOLE_COMMANDS } from './console'

/**
 * The single operation layer behind the Meta command center. Every surface —
 * table switches, budget popovers, dialogs, and the `fb>` console — funnels
 * through these functions, so a console `pause` is gated, audited, and
 * mirrored exactly like the button. Callers MUST have already passed
 * requirePermission('connectors:manage'); nothing here re-gates.
 */

export type OpResult = { ok: true; message: string } | { ok: false; message: string }

type Target =
  | { type: 'campaign'; id: string; name: string }
  | { type: 'adset'; id: string; name: string }

/**
 * Resolves what the operator typed — a local id, a Meta external id, or a
 * name fragment — to exactly one campaign or ad set. Ambiguity is an error,
 * never a guess: this console moves money.
 */
export async function resolveTarget(organizationId: string, ref: string): Promise<Target | { error: string }> {
  const byId = await db.campaign.findFirst({
    where: { organizationId, channel: 'meta', OR: [{ id: ref }, { externalId: ref }] },
  })
  if (byId) return { type: 'campaign', id: byId.id, name: byId.name }

  const adById = await db.adSet.findFirst({
    where: { organizationId, OR: [{ id: ref }, { externalId: ref }] },
  })
  if (adById) return { type: 'adset', id: adById.id, name: adById.name }

  const campaigns = await db.campaign.findMany({
    where: { organizationId, channel: 'meta', name: { contains: ref, mode: 'insensitive' } },
    take: 3,
  })
  const adSets = await db.adSet.findMany({
    where: { organizationId, name: { contains: ref, mode: 'insensitive' }, campaign: { channel: 'meta' } },
    take: 3,
  })
  const matches: Target[] = [
    ...campaigns.map((c) => ({ type: 'campaign' as const, id: c.id, name: c.name })),
    ...adSets.map((a) => ({ type: 'adset' as const, id: a.id, name: a.name })),
  ]
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) return { error: `Nothing named or id'd "${ref}" — \`list\` shows ids.` }
  return {
    error: `"${ref}" is ambiguous (${matches.map((m) => `${m.type} "${m.name}"`).join(', ')}). Use an id from \`list\`.`,
  }
}

export async function opSetCampaignStatus(user: SessionUser, campaignId: string, status: 'ACTIVE' | 'PAUSED'): Promise<OpResult> {
  const provider = await getMetaProviderFor(user.organizationId)
  try {
    await provider.setCampaignStatus(user.organizationId, campaignId, status)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Status change failed.' }
  }
  await recordAudit(user, {
    action: status === 'ACTIVE' ? 'meta.campaign_resumed' : 'meta.campaign_paused',
    entityType: 'Campaign',
    entityId: campaignId,
  })
  return { ok: true, message: `Campaign ${status === 'ACTIVE' ? 'resumed' : 'paused'}.` }
}

export async function opSetAdSetStatus(user: SessionUser, adSetId: string, status: 'ACTIVE' | 'PAUSED'): Promise<OpResult> {
  const provider = await getMetaProviderFor(user.organizationId)
  try {
    await provider.setAdSetStatus(user.organizationId, adSetId, status)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Status change failed.' }
  }
  await recordAudit(user, {
    action: status === 'ACTIVE' ? 'meta.adset_resumed' : 'meta.adset_paused',
    entityType: 'AdSet',
    entityId: adSetId,
  })
  return { ok: true, message: `Ad set ${status === 'ACTIVE' ? 'resumed' : 'paused'}.` }
}

export async function opSetBudget(user: SessionUser, target: { type: 'campaign' | 'adset'; id: string }, usd: number): Promise<OpResult> {
  const provider = await getMetaProviderFor(user.organizationId)
  try {
    if (target.type === 'campaign') await provider.updateDailyBudget(user.organizationId, target.id, usd)
    else await provider.updateAdSetBudget(user.organizationId, target.id, usd)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Budget update failed.' }
  }
  await recordAudit(user, {
    action: 'meta.budget_changed',
    entityType: target.type === 'campaign' ? 'Campaign' : 'AdSet',
    entityId: target.id,
    summary: `Daily budget → ${currency(usd)}`,
  })
  return { ok: true, message: `Daily budget set to ${currency(usd)}/day.` }
}

export async function opSetSpendCap(user: SessionUser, campaignId: string, usd: number): Promise<OpResult> {
  const provider = await getMetaProviderFor(user.organizationId)
  try {
    await provider.setCampaignSpendCap(user.organizationId, campaignId, usd)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Spend cap update failed.' }
  }
  await recordAudit(user, {
    action: 'meta.spend_cap_changed',
    entityType: 'Campaign',
    entityId: campaignId,
    summary: `Lifetime spend cap → ${currency(usd)}`,
  })
  return { ok: true, message: `Lifetime spend cap set to ${currency(usd)}. This is a lifetime ceiling, not a daily budget.` }
}

export async function opCreateAdAccount(user: SessionUser, input: { name: string; currency: string; timezone: string }): Promise<OpResult> {
  const provider = await getMetaProviderFor(user.organizationId)
  let created: { id: string; mode: 'mock' | 'live' }
  try {
    created = await provider.createAdAccount(user.organizationId, input)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Ad account creation failed.' }
  }
  await recordAudit(user, {
    action: 'meta.ad_account_created',
    entityType: 'Connector',
    summary: `Created Meta ad account "${input.name}" (${input.currency}, ${created.mode})`,
  })
  return {
    ok: true,
    message: created.mode === 'mock'
      ? `Mock ad account ${created.id} "created" — nothing real exists until Meta credentials are configured.`
      : `Ad account ${created.id} created. Point META_AD_ACCOUNT_ID at it to manage its campaigns here.`,
  }
}

/**
 * Executes one parsed console command. Mutating commands land on the exact
 * same audited operations the buttons use; read commands print from the same
 * provider the page renders from.
 */
export async function runConsoleCommand(user: SessionUser, command: ConsoleCommand): Promise<{ lines: string[]; mutated: boolean }> {
  const orgId = user.organizationId
  const provider = await getMetaProviderFor(orgId)

  switch (command.kind) {
    case 'help':
      return {
        mutated: false,
        lines: CONSOLE_COMMANDS.map((c) => `${c.usage.padEnd(44)} ${c.description}`),
      }

    case 'list': {
      const [campaigns, adSets] = await Promise.all([
        provider.listCampaigns(orgId),
        provider.listAdSets(orgId),
      ])
      if (campaigns.length === 0) return { mutated: false, lines: ['No Meta campaigns yet — `create-account` or the New campaign button starts one.'] }
      const lines: string[] = []
      for (const c of campaigns) {
        const cap = c.spendCap !== null ? ` cap ${currency(c.spendCap)}` : ''
        lines.push(`${c.status === 'ACTIVE' ? '●' : '○'} ${c.id}  ${c.name}  [${c.status.toLowerCase()}]  ${currency(c.dailyBudget)}/day${cap}  spent ${currency(c.spend)}  leads ${c.leads}`)
        for (const a of adSets.filter((a) => a.campaignId === c.id)) {
          lines.push(`    ${a.status === 'ACTIVE' ? '●' : '○'} ${a.id}  ${a.name}  [${a.status.toLowerCase()}]  ${currency(a.dailyBudget)}/day  spent ${currency(a.spend)}`)
        }
      }
      return { mutated: false, lines }
    }

    case 'spend': {
      const stats = await provider.dailyStats(orgId, command.days)
      if (stats.length === 0) return { mutated: false, lines: [`No spend recorded in the last ${command.days} days.`] }
      const lines = stats.map((s) => `${s.date}  ${currency(s.spend).padStart(12)}  ${s.leads} leads`)
      const total = stats.reduce((a, s) => a + s.spend, 0)
      lines.push(`total ${' '.repeat(4)}${currency(Math.round(total * 100) / 100).padStart(12)}`)
      return { mutated: false, lines }
    }

    case 'status': {
      const target = await resolveTarget(orgId, command.ref)
      if ('error' in target) return { mutated: false, lines: [target.error] }
      const res = target.type === 'campaign'
        ? await opSetCampaignStatus(user, target.id, command.status)
        : await opSetAdSetStatus(user, target.id, command.status)
      return { mutated: res.ok, lines: [`${res.ok ? '✓' : '✗'} ${target.type} "${target.name}": ${res.message}`] }
    }

    case 'budget': {
      const target = await resolveTarget(orgId, command.ref)
      if ('error' in target) return { mutated: false, lines: [target.error] }
      const res = await opSetBudget(user, target, command.usd)
      return { mutated: res.ok, lines: [`${res.ok ? '✓' : '✗'} ${target.type} "${target.name}": ${res.message}`] }
    }

    case 'cap': {
      const target = await resolveTarget(orgId, command.ref)
      if ('error' in target) return { mutated: false, lines: [target.error] }
      if (target.type !== 'campaign') {
        return { mutated: false, lines: ['Spend caps are campaign-level on Meta — pick a campaign, not an ad set.'] }
      }
      const res = await opSetSpendCap(user, target.id, command.usd)
      return { mutated: res.ok, lines: [`${res.ok ? '✓' : '✗'} campaign "${target.name}": ${res.message}`] }
    }

    case 'create-account': {
      const res = await opCreateAdAccount(user, { name: command.name, currency: command.currency, timezone: command.timezone })
      return { mutated: res.ok, lines: [`${res.ok ? '✓' : '✗'} ${res.message}`] }
    }
  }
}
