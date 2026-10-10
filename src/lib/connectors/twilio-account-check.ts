import type { ConnectorKind } from '@prisma/client'
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/crypto'

/**
 * The save-time check for Twilio credentials on the twilio-sms and
 * twilio-voice connectors.
 *
 * Whatever an org stores here becomes "its own" carrier account: webhooks for
 * its lines are verified with that token, and its telephony:manage holders may
 * change that account's carrier state. So an Account SID is only accepted when
 *
 *  - it is NOT the platform subaccount's (TWILIO_ACCOUNT_SID). That SID is no
 *    secret — it is the `sub` of every voice token — so typing it in must never
 *    turn a tenant into the shared account's owner; and
 *  - with live carriers on (TELEPHONY_PROVIDER or SMS_PROVIDER = twilio), the
 *    SID and token answer Twilio's own GET /Accounts/{sid}.json with that
 *    same SID. With the mock carrier nothing leaves the server.
 *
 * The connector form saves one field at a time, so the pair checked is the
 * incoming values merged over what is already stored. A SID with no token yet
 * is only checked against the platform SID; the pair is checked once both
 * exist. Credential values never appear in an error message.
 *
 * Not `server-only` on purpose: provision.ts (which is not either) imports it,
 * and this module only ever runs inside its db-backed, server-side functions.
 */

export const TWILIO_CONNECTOR_KINDS: ReadonlySet<ConnectorKind> = new Set<ConnectorKind>(['TWILIO_SMS', 'TWILIO_VOICE'])

export const PLATFORM_SID_REFUSED =
  "That Account SID is the shared platform account. Enter your own Twilio account's SID, or leave this connector empty to use the platform."
export const PAIR_REFUSED = "Twilio didn't accept that Account SID and Auth Token together. Check both and save again."
export const CHECK_UNAVAILABLE = "We couldn't reach Twilio to check these credentials, so nothing was saved. Try again in a moment."
export const BAD_SID = "That isn't a Twilio Account SID. It starts with AC and has 34 characters."

export type TwilioCheck = { ok: true } | { ok: false; error: string }

const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/

export function isPlatformSid(sid: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const platform = env.TWILIO_ACCOUNT_SID?.trim()
  return Boolean(platform && sid && sid.trim() === platform)
}

/** True when a real carrier is in use, so credentials are worth checking with Twilio. */
export function liveTwilioChecks(env: NodeJS.ProcessEnv = process.env): boolean {
  const key = (v: string | undefined) => (v ?? '').trim().toLowerCase()
  return key(env.TELEPHONY_PROVIDER) === 'twilio' || key(env.SMS_PROVIDER) === 'twilio'
}

/** Pure request builder: exactly what is fetched, testable offline. */
export function buildAccountCheckRequest(accountSid: string, authToken: string): { url: string; init: RequestInit } {
  return {
    url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`,
    init: {
      method: 'GET',
      headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` },
    },
  }
}

/** Check one SID/token pair (either may be missing while the form fills in). */
export async function checkTwilioPair(
  pair: { accountSid?: string | null; authToken?: string | null },
  opts: { fetcher?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<TwilioCheck> {
  const env = opts.env ?? process.env
  const accountSid = pair.accountSid?.trim() || ''
  const authToken = pair.authToken?.trim() || ''
  if (!accountSid) return { ok: true }
  if (isPlatformSid(accountSid, env)) return { ok: false, error: PLATFORM_SID_REFUSED }
  if (!authToken || !liveTwilioChecks(env)) return { ok: true }
  if (!ACCOUNT_SID.test(accountSid)) return { ok: false, error: BAD_SID }

  const { url, init } = buildAccountCheckRequest(accountSid, authToken)
  let status: number
  let body: unknown = null
  try {
    const res = await (opts.fetcher ?? fetch)(url, { ...init, signal: AbortSignal.timeout(8000) })
    status = res.status
    body = await res.json().catch(() => null)
  } catch {
    return { ok: false, error: CHECK_UNAVAILABLE }
  }
  if (status === 401 || status === 403 || status === 404) return { ok: false, error: PAIR_REFUSED }
  if (status < 200 || status >= 300) return { ok: false, error: CHECK_UNAVAILABLE }
  const sid = (body as { sid?: unknown } | null)?.sid
  return sid === accountSid ? { ok: true } : { ok: false, error: PAIR_REFUSED }
}

/** What this org's connector already stores for the two fields that matter. */
async function storedPair(organizationId: string, kind: ConnectorKind): Promise<{ accountSid?: string; authToken?: string }> {
  const rows = await db.connectorCredential.findMany({
    where: { organizationId, connector: { kind }, fieldKey: { in: ['accountSid', 'authToken'] } },
    select: { fieldKey: true, ciphertext: true, iv: true, authTag: true, keyVersion: true },
  })
  const out: { accountSid?: string; authToken?: string } = {}
  for (const row of rows) {
    try {
      out[row.fieldKey as 'accountSid' | 'authToken'] = decryptSecret(row)
    } catch {
      // Unreadable: treat as not stored, so the incoming value is what is checked.
    }
  }
  return out
}

/**
 * The check saveConnectorCredentials / rotateConnectorCredential run before
 * anything is written. Non-Twilio connectors always pass.
 */
export async function checkTwilioConnectorSave(
  organizationId: string,
  kind: ConnectorKind,
  incoming: Record<string, string>,
  opts: { fetcher?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<TwilioCheck> {
  if (!TWILIO_CONNECTOR_KINDS.has(kind)) return { ok: true }
  if (!('accountSid' in incoming) && !('authToken' in incoming)) return { ok: true }
  const stored = await storedPair(organizationId, kind)
  return checkTwilioPair(
    { accountSid: incoming.accountSid ?? stored.accountSid, authToken: incoming.authToken ?? stored.authToken },
    opts,
  )
}
