import type { PhoneNumberKind } from '@prisma/client'
import type {
  AvailableNumber,
  NumberCapabilities,
  PurchaseInput,
  PurchaseResult,
  ReleaseResult,
  SearchNumbersInput,
  TelephonyCredentials,
  TelephonyProvider,
} from './provider'
import { formatE164 } from './provider'

/**
 * Twilio number provisioning — the real carrier behind the console.
 *
 * Three REST calls, all on api.twilio.com/2010-04-01, all Basic-authed with
 * the account's own SID/token (so an agency-owned subaccount bills to that
 * subaccount):
 *
 *   GET    /Accounts/{sid}/AvailablePhoneNumbers/US/{Local|TollFree}.json
 *   POST   /Accounts/{sid}/IncomingPhoneNumbers.json
 *   DELETE /Accounts/{sid}/IncomingPhoneNumbers/{PN sid}.json
 *
 * The request builders and response mappers below are pure so the whole
 * contract is unit-testable without a network or an account — the same shape
 * as buildTwilioRequest in src/lib/messaging/twilio.ts.
 */

const API_ROOT = 'https://api.twilio.com/2010-04-01'

function basicAuth(creds: TelephonyCredentials): string {
  return `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`
}

// ── Search ───────────────────────────────────────────────────────────────────

export function buildSearchRequest(
  input: SearchNumbersInput,
  creds: TelephonyCredentials,
): { url: string; init: RequestInit } {
  const path = input.kind === 'TOLL_FREE' ? 'TollFree' : 'Local'
  const params = new URLSearchParams({
    PageSize: String(Math.min(Math.max(input.limit ?? 8, 1), 20)),
    // Only offer numbers that can do both jobs the app asks of them.
    SmsEnabled: 'true',
    VoiceEnabled: 'true',
  })
  const areaCode = (input.areaCode ?? '').replace(/\D/g, '').slice(0, 3)
  if (input.kind === 'LOCAL' && areaCode.length === 3) params.set('AreaCode', areaCode)
  if (input.region) params.set('InRegion', input.region.toUpperCase().slice(0, 2))
  if (input.contains) params.set('Contains', input.contains.toUpperCase().replace(/[^0-9A-Z*]/g, ''))

  return {
    url: `${API_ROOT}/Accounts/${encodeURIComponent(creds.accountSid)}/AvailablePhoneNumbers/US/${path}.json?${params.toString()}`,
    init: { method: 'GET', headers: { Authorization: basicAuth(creds) } },
  }
}

type TwilioAvailableRow = {
  phone_number?: unknown
  friendly_name?: unknown
  region?: unknown
  locality?: unknown
  capabilities?: { SMS?: unknown; MMS?: unknown; voice?: unknown }
}

function capabilitiesFrom(raw: TwilioAvailableRow['capabilities']): NumberCapabilities {
  return { sms: raw?.SMS === true, mms: raw?.MMS === true, voice: raw?.voice === true }
}

export function parseSearchResponse(body: unknown, kind: PhoneNumberKind): AvailableNumber[] {
  const rows = (body as { available_phone_numbers?: TwilioAvailableRow[] })?.available_phone_numbers
  if (!Array.isArray(rows)) return []
  const out: AvailableNumber[] = []
  for (const row of rows) {
    if (typeof row.phone_number !== 'string') continue
    const e164 = row.phone_number
    out.push({
      e164,
      friendly: typeof row.friendly_name === 'string' ? row.friendly_name : formatE164(e164),
      kind,
      areaCode: /^\+1(\d{3})/.exec(e164)?.[1] ?? null,
      region: typeof row.region === 'string' ? row.region : null,
      locality: typeof row.locality === 'string' ? row.locality : null,
      capabilities: capabilitiesFrom(row.capabilities),
    })
  }
  return out
}

// ── Purchase ─────────────────────────────────────────────────────────────────

/**
 * The webhook URLs are set in the SAME call that buys the number: a line that
 * exists but points nowhere would silently drop a customer's first call.
 */
export function buildPurchaseRequest(
  input: PurchaseInput,
  creds: TelephonyCredentials,
): { url: string; init: RequestInit } {
  const body = new URLSearchParams({
    PhoneNumber: input.e164,
    FriendlyName: input.friendlyName.slice(0, 64),
    VoiceUrl: input.webhooks.voiceUrl,
    VoiceMethod: 'POST',
    StatusCallback: input.webhooks.voiceStatusUrl,
    StatusCallbackMethod: 'POST',
    SmsUrl: input.webhooks.smsUrl,
    SmsMethod: 'POST',
  })
  return {
    url: `${API_ROOT}/Accounts/${encodeURIComponent(creds.accountSid)}/IncomingPhoneNumbers.json`,
    init: {
      method: 'POST',
      headers: { Authorization: basicAuth(creds), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
  }
}

export function purchaseResultFromResponse(status: number, body: unknown): PurchaseResult {
  const record = (body ?? {}) as Record<string, unknown> & {
    capabilities?: { sms?: unknown; mms?: unknown; voice?: unknown }
  }
  if (status >= 200 && status < 300 && typeof record.phone_number === 'string' && typeof record.sid === 'string') {
    const e164 = record.phone_number
    return {
      ok: true,
      number: {
        e164,
        providerSid: record.sid,
        capabilities: {
          sms: record.capabilities?.sms === true,
          mms: record.capabilities?.mms === true,
          voice: record.capabilities?.voice === true,
        },
        areaCode: /^\+1(\d{3})/.exec(e164)?.[1] ?? null,
        region: typeof record.region === 'string' ? record.region : null,
        locality: typeof record.locality === 'string' ? record.locality : null,
      },
    }
  }
  const message =
    typeof record.message === 'string' && record.message
      ? record.message
      : `Twilio API error (HTTP ${status}).`
  const code = typeof record.code === 'number' ? ` [code ${record.code}]` : ''
  return { ok: false, error: `${message}${code}`.slice(0, 500) }
}

// ── Release ──────────────────────────────────────────────────────────────────

export function buildReleaseRequest(
  providerSid: string,
  creds: TelephonyCredentials,
): { url: string; init: RequestInit } {
  return {
    url: `${API_ROOT}/Accounts/${encodeURIComponent(creds.accountSid)}/IncomingPhoneNumbers/${encodeURIComponent(providerSid)}.json`,
    init: { method: 'DELETE', headers: { Authorization: basicAuth(creds) } },
  }
}

export class TwilioTelephonyProvider implements TelephonyProvider {
  readonly name = 'twilio'
  readonly isMock = false

  async searchNumbers(input: SearchNumbersInput, creds: TelephonyCredentials): Promise<AvailableNumber[]> {
    const { url, init } = buildSearchRequest(input, creds)
    const res = await fetch(url, init)
    if (!res.ok) return []
    return parseSearchResponse(await res.json().catch(() => null), input.kind)
  }

  async purchase(input: PurchaseInput, creds: TelephonyCredentials): Promise<PurchaseResult> {
    try {
      const { url, init } = buildPurchaseRequest(input, creds)
      const res = await fetch(url, init)
      const body = await res.json().catch(() => null)
      return purchaseResultFromResponse(res.status, body)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Twilio request failed: ${detail}`.slice(0, 500) }
    }
  }

  async release(providerSid: string, creds: TelephonyCredentials): Promise<ReleaseResult> {
    try {
      const { url, init } = buildReleaseRequest(providerSid, creds)
      const res = await fetch(url, init)
      // 204 on success; a 404 means it is already gone, which is the goal state.
      if (res.status === 204 || res.status === 404) return { ok: true }
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      const message = typeof body?.message === 'string' ? body.message : `Twilio API error (HTTP ${res.status}).`
      return { ok: false, error: message.slice(0, 500) }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Twilio request failed: ${detail}`.slice(0, 500) }
    }
  }
}
