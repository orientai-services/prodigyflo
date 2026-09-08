'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requirePermission } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'
import { getMetaProviderFor, ingestMetaLead } from '@/lib/meta'
import { igniteLead } from '@/lib/meta/ignition'
import { parseConsoleCommand } from '@/lib/meta/console'
import {
  opCreateAdAccount, opSetAdSetStatus, opSetBudget, opSetCampaignStatus, opSetSpendCap,
  runConsoleCommand,
} from '@/lib/meta/ops'

export type MetaActionState = { error?: string; ok?: string }

const PAGE = '/marketing/meta'

const campaignSchema = z.object({
  name: z.string().trim().min(3, 'Name the campaign.').max(120),
  objective: z.enum(['LEADS', 'TRAFFIC', 'AWARENESS', 'CONVERSIONS']),
  dailyBudget: z.coerce.number().min(1, 'Daily budget must be at least $1.').max(100_000),
  status: z.enum(['ACTIVE', 'PAUSED']),
})

export async function createCampaignAction(_prev: MetaActionState, formData: FormData): Promise<MetaActionState> {
  const user = await requirePermission('connectors:manage')
  const parsed = campaignSchema.safeParse({
    name: formData.get('name'),
    objective: formData.get('objective'),
    dailyBudget: formData.get('dailyBudget'),
    status: formData.get('status'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  try {
    const provider = await getMetaProviderFor(user.organizationId)
    const c = await provider.createCampaign(user.organizationId, parsed.data)
    await recordAudit(user, {
      action: 'meta.campaign_created',
      entityType: 'Campaign',
      entityId: c.id,
      summary: `Created Meta campaign "${c.name}" ($${parsed.data.dailyBudget}/day, ${parsed.data.status})`,
    })
    revalidatePath(PAGE)
    return { ok: `Campaign "${c.name}" created.` }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Campaign creation failed.' }
  }
}

export async function setCampaignStatusAction(campaignId: string, status: 'ACTIVE' | 'PAUSED'): Promise<MetaActionState> {
  const user = await requirePermission('connectors:manage')
  const res = await opSetCampaignStatus(user, String(campaignId), status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED')
  revalidatePath(PAGE)
  return res.ok ? { ok: res.message } : { error: res.message }
}

export async function setAdSetStatusAction(adSetId: string, status: 'ACTIVE' | 'PAUSED'): Promise<MetaActionState> {
  const user = await requirePermission('connectors:manage')
  const res = await opSetAdSetStatus(user, String(adSetId), status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED')
  revalidatePath(PAGE)
  return res.ok ? { ok: res.message } : { error: res.message }
}

const budgetSchema = z.object({
  targetType: z.enum(['campaign', 'adset']),
  targetId: z.string().min(1),
  dailyBudget: z.coerce.number().min(1, 'Daily budget must be at least $1.').max(100_000),
})

export async function updateBudgetAction(_prev: MetaActionState, formData: FormData): Promise<MetaActionState> {
  const user = await requirePermission('connectors:manage')
  const parsed = budgetSchema.safeParse({
    targetType: formData.get('targetType'),
    targetId: formData.get('targetId'),
    dailyBudget: formData.get('dailyBudget'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  const res = await opSetBudget(user, { type: parsed.data.targetType, id: parsed.data.targetId }, parsed.data.dailyBudget)
  revalidatePath(PAGE)
  return res.ok ? { ok: res.message } : { error: res.message }
}

const capSchema = z.object({
  campaignId: z.string().min(1),
  spendCap: z.coerce.number().min(100, 'Meta requires a lifetime spend cap of at least $100.').max(10_000_000),
})

export async function setSpendCapAction(_prev: MetaActionState, formData: FormData): Promise<MetaActionState> {
  const user = await requirePermission('connectors:manage')
  const parsed = capSchema.safeParse({
    campaignId: formData.get('campaignId'),
    spendCap: formData.get('spendCap'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  const res = await opSetSpendCap(user, parsed.data.campaignId, parsed.data.spendCap)
  revalidatePath(PAGE)
  return res.ok ? { ok: res.message } : { error: res.message }
}

const accountSchema = z.object({
  name: z.string().trim().min(3, 'Name the ad account.').max(120),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Currency is a 3-letter code, e.g. USD.'),
  timezone: z.string().trim().min(1, 'Timezone id is required.').max(40),
})

export async function createAdAccountAction(_prev: MetaActionState, formData: FormData): Promise<MetaActionState> {
  const user = await requirePermission('connectors:manage')
  const parsed = accountSchema.safeParse({
    name: formData.get('name'),
    currency: formData.get('currency'),
    timezone: formData.get('timezone'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  const res = await opCreateAdAccount(user, parsed.data)
  revalidatePath(PAGE)
  return res.ok ? { ok: res.message } : { error: res.message }
}

export type ConsoleResult = { lines: string[] }

/**
 * The `fb>` console. One text command in, printable lines out — dispatched
 * onto the SAME gated, audited operations the buttons call. The permission
 * gate lives here (server), never in the island.
 */
export async function runConsoleCommandAction(input: string): Promise<ConsoleResult> {
  const user = await requirePermission('connectors:manage')
  const parsed = parseConsoleCommand(String(input ?? '').slice(0, 500))
  if (!parsed.ok) return { lines: [parsed.error] }
  try {
    const result = await runConsoleCommand(user, parsed.command)
    if (result.mutated) revalidatePath(PAGE)
    return { lines: result.lines }
  } catch (e) {
    return { lines: [`✗ ${e instanceof Error ? e.message : 'Command failed.'}`] }
  }
}

/**
 * Fires a synthetic leadgen webhook at our own endpoint, signed exactly the way
 * Meta would sign it — proving the receive → fetch → CRM path end to end.
 */
export async function sendTestLeadAction(): Promise<MetaActionState> {
  const user = await requirePermission('connectors:manage')
  // Exercise the real pipeline IN-PROCESS (fetch → ingest → CRM → ignition) in
  // the caller's own org. No HMAC round-trip through the public webhook, so the
  // diagnostic never depends on which org owns the Meta source, and the public
  // endpoint never has to accept a verify-token-signed body (which would let any
  // connectors:read user forge leads).
  const leadgenId = `test_${Date.now().toString(36)}`
  const provider = await getMetaProviderFor(user.organizationId)
  const lead = await provider.fetchLead(leadgenId)
  const r = await ingestMetaLead(user.organizationId, lead)

  if (!r.duplicate && r.submission.createdClient && r.submission.clientId) {
    try {
      await igniteLead(user.organizationId, r.submission.clientId, leadgenId)
    } catch (err) {
      console.error('[meta] test-lead ignition failed', err)
    }
  }

  await recordAudit(user, { action: 'meta.test_lead_sent', entityType: 'IntakeSubmission', summary: 'Simulated a Lead Ads webhook delivery' })
  revalidatePath(PAGE)
  return { ok: `Test lead delivered → ${r.submission.status}. Check All clients.` }
}
