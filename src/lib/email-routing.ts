import 'server-only'
import { db } from '@/lib/db'

/**
 * Cloudflare Email Routing: gives every staff member a real alias@<domain>
 * address that forwards to their personal inbox.
 *
 * Two-step by Cloudflare's design: saving a destination triggers a verification
 * email from Cloudflare to that inbox; the forwarding RULE can only be created
 * once the destination is verified. `forwardingStatus` tracks it:
 *   none → pending (verification email sent) → active (rule created).
 */

const API = 'https://api.cloudflare.com/client/v4'

function config() {
  const token = process.env.CLOUDFLARE_EMAIL_TOKEN
  const accountId = process.env.CF_ACCOUNT_ID
  const zoneId = process.env.CF_EMAIL_ZONE_ID
  const domain = process.env.EMAIL_DOMAIN || 'prodigyflo.ai'
  return { token, accountId, zoneId, domain, ok: Boolean(token && accountId && zoneId) }
}

export function emailRoutingConfigured(): boolean {
  return config().ok
}

export function emailDomain(): string {
  return config().domain
}

type CfEnvelope<T> = { success: boolean; result: T; errors?: { message: string }[] }

async function cf<T>(path: string, init?: RequestInit): Promise<T> {
  const { token } = config()
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init?.headers },
  })
  const body = (await res.json()) as CfEnvelope<T>
  if (!body.success) throw new Error(`Cloudflare: ${body.errors?.[0]?.message ?? res.statusText}`)
  return body.result
}

type Destination = { id: string; email: string; verified?: string | null }
type Rule = { id: string; tag: string; matchers: { field?: string; value?: string }[] }

/** Finds or creates the destination address; creation triggers the verification email. */
async function ensureDestination(email: string): Promise<Destination> {
  const { accountId } = config()
  const list = await cf<Destination[]>(`/accounts/${accountId}/email/routing/addresses?per_page=50`)
  const existing = list.find((d) => d.email.toLowerCase() === email.toLowerCase())
  if (existing) return existing
  return cf<Destination>(`/accounts/${accountId}/email/routing/addresses`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

async function findRuleForAlias(aliasAddress: string): Promise<Rule | null> {
  const { zoneId } = config()
  const rules = await cf<Rule[]>(`/zones/${zoneId}/email/routing/rules?per_page=50`)
  return (
    rules.find((r) =>
      r.matchers.some((m) => m.field === 'to' && m.value?.toLowerCase() === aliasAddress.toLowerCase()),
    ) ?? null
  )
}

/**
 * Saves a user's forwarding setup. Returns the resulting status. Safe to call
 * repeatedly — it converges: destination ensured, rule created when verified,
 * stale rule replaced when the alias or destination changed.
 */
export async function syncForwarding(userId: string): Promise<'none' | 'pending' | 'active'> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } })
  if (!config().ok) return (user.forwardingStatus as 'none' | 'pending' | 'active') ?? 'none'
  if (!user.emailAlias || !user.forwardingEmail) {
    await db.user.update({ where: { id: userId }, data: { forwardingStatus: 'none' } })
    return 'none'
  }

  const aliasAddress = `${user.emailAlias}@${config().domain}`
  const destination = await ensureDestination(user.forwardingEmail)

  if (!destination.verified) {
    await db.user.update({ where: { id: userId }, data: { forwardingStatus: 'pending' } })
    return 'pending'
  }

  const existing = await findRuleForAlias(aliasAddress)
  if (!existing) {
    await cf(`/zones/${config().zoneId}/email/routing/rules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `forward ${aliasAddress}`,
        enabled: true,
        matchers: [{ type: 'literal', field: 'to', value: aliasAddress }],
        actions: [{ type: 'forward', value: [user.forwardingEmail] }],
      }),
    })
  }

  await db.user.update({ where: { id: userId }, data: { forwardingStatus: 'active' } })
  return 'active'
}

/** Removes the forwarding rule for a user's previous alias (alias change / cleanup). */
export async function removeForwardingRule(aliasLocal: string): Promise<void> {
  if (!config().ok || !aliasLocal) return
  const aliasAddress = `${aliasLocal}@${config().domain}`
  const rule = await findRuleForAlias(aliasAddress)
  if (rule) {
    await cf(`/zones/${config().zoneId}/email/routing/rules/${rule.id ?? rule.tag}`, { method: 'DELETE' })
  }
}
