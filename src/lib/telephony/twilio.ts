import type { PhoneNumberKind } from '@prisma/client'
import type {
  AvailableNumber,
  NumberCapabilities,
  NumberWebhooks,
  OwnedNumber,
  OwnedNumbersResult,
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
  if (input.webhooks.voiceFallbackUrl) {
    body.set('VoiceFallbackUrl', input.webhooks.voiceFallbackUrl)
    body.set('VoiceFallbackMethod', 'POST')
  }
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

// ── Owned numbers (import + drift) ───────────────────────────────────────────

const API_HOST = 'https://api.twilio.com'

/** First page, or the next one from Twilio's `next_page_uri`. PageSize 1000 is Twilio's max. */
export function buildListNumbersRequest(
  creds: TelephonyCredentials,
  nextPageUri?: string | null,
): { url: string; init: RequestInit } {
  const url = nextPageUri
    ? `${API_HOST}${nextPageUri.startsWith('/') ? '' : '/'}${nextPageUri}`
    : `${API_ROOT}/Accounts/${encodeURIComponent(creds.accountSid)}/IncomingPhoneNumbers.json?PageSize=1000`
  return { url, init: { method: 'GET', headers: { Authorization: basicAuth(creds) } } }
}

type TwilioOwnedRow = {
  sid?: unknown
  phone_number?: unknown
  friendly_name?: unknown
  capabilities?: { sms?: unknown; mms?: unknown; voice?: unknown; SMS?: unknown; MMS?: unknown }
  voice_url?: unknown
  sms_url?: unknown
  status_callback?: unknown
  voice_fallback_url?: unknown
  date_created?: unknown
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

export function parseListNumbersResponse(body: unknown): { numbers: OwnedNumber[]; nextPageUri: string | null } {
  const record = (body ?? {}) as { incoming_phone_numbers?: TwilioOwnedRow[]; next_page_uri?: unknown }
  const rows = Array.isArray(record.incoming_phone_numbers) ? record.incoming_phone_numbers : []
  const numbers: OwnedNumber[] = []
  for (const row of rows) {
    const sid = str(row.sid)
    const e164 = str(row.phone_number)
    if (!sid || !e164) continue
    numbers.push({
      sid,
      e164,
      friendlyName: str(row.friendly_name) ?? formatE164(e164),
      capabilities: {
        sms: row.capabilities?.sms === true || row.capabilities?.SMS === true,
        mms: row.capabilities?.mms === true || row.capabilities?.MMS === true,
        voice: row.capabilities?.voice === true,
      },
      voiceUrl: str(row.voice_url),
      smsUrl: str(row.sms_url),
      statusCallback: str(row.status_callback),
      voiceFallbackUrl: str(row.voice_fallback_url),
      dateCreated: str(row.date_created),
    })
  }
  return { numbers, nextPageUri: str(record.next_page_uri) }
}

export function buildUpdateWebhooksRequest(
  providerSid: string,
  webhooks: NumberWebhooks,
  creds: TelephonyCredentials,
): { url: string; init: RequestInit } {
  const body = new URLSearchParams({
    VoiceUrl: webhooks.voiceUrl,
    VoiceMethod: 'POST',
    StatusCallback: webhooks.voiceStatusUrl,
    StatusCallbackMethod: 'POST',
    SmsUrl: webhooks.smsUrl,
    SmsMethod: 'POST',
  })
  if (webhooks.voiceFallbackUrl) {
    body.set('VoiceFallbackUrl', webhooks.voiceFallbackUrl)
    body.set('VoiceFallbackMethod', 'POST')
  }
  return {
    url: `${API_ROOT}/Accounts/${encodeURIComponent(creds.accountSid)}/IncomingPhoneNumbers/${encodeURIComponent(providerSid)}.json`,
    init: {
      method: 'POST',
      headers: { Authorization: basicAuth(creds), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
  }
}

// ── Account state reads (status card + sweep) ────────────────────────────────

function get(url: string, creds: TelephonyCredentials): { url: string; init: RequestInit } {
  return { url, init: { method: 'GET', headers: { Authorization: basicAuth(creds) } } }
}

export function buildBalanceRequest(creds: TelephonyCredentials) {
  return get(`${API_ROOT}/Accounts/${encodeURIComponent(creds.accountSid)}/Balance.json`, creds)
}

/** { balance: "41.20", currency: "USD" } → "$41.20". */
export function parseBalance(body: unknown): { balance: string; currency: string } | null {
  const record = (body ?? {}) as { balance?: unknown; currency?: unknown }
  const raw = typeof record.balance === 'string' || typeof record.balance === 'number' ? Number(record.balance) : NaN
  if (!Number.isFinite(raw)) return null
  const currency = typeof record.currency === 'string' ? record.currency.toUpperCase() : 'USD'
  const amount = Math.abs(raw).toFixed(2)
  const sign = raw < 0 ? '-' : ''
  return { balance: currency === 'USD' ? `${sign}$${amount}` : `${sign}${amount} ${currency}`, currency }
}

export function buildFetchMessageRequest(messageSid: string, creds: TelephonyCredentials) {
  return get(`${API_ROOT}/Accounts/${encodeURIComponent(creds.accountSid)}/Messages/${encodeURIComponent(messageSid)}.json`, creds)
}

export function parseMessageStatus(body: unknown): { status: string; errorCode: string | null } | null {
  const record = (body ?? {}) as { status?: unknown; error_code?: unknown }
  if (typeof record.status !== 'string') return null
  const code = record.error_code
  return {
    status: record.status.toLowerCase(),
    errorCode: typeof code === 'number' || (typeof code === 'string' && code) ? String(code) : null,
  }
}

export function buildFetchCallRequest(callSid: string, creds: TelephonyCredentials) {
  return get(`${API_ROOT}/Accounts/${encodeURIComponent(creds.accountSid)}/Calls/${encodeURIComponent(callSid)}.json`, creds)
}

export function parseCallStatus(body: unknown): { status: string; durationSeconds: number | null; endedAt: Date | null } | null {
  const record = (body ?? {}) as { status?: unknown; duration?: unknown; end_time?: unknown }
  if (typeof record.status !== 'string') return null
  const duration = Number.parseInt(String(record.duration ?? ''), 10)
  const end = typeof record.end_time === 'string' ? new Date(record.end_time) : null
  return {
    status: record.status.toLowerCase(),
    durationSeconds: Number.isFinite(duration) ? duration : null,
    endedAt: end && !Number.isNaN(end.getTime()) ? end : null,
  }
}

export function buildCallRecordingsRequest(callSid: string, creds: TelephonyCredentials) {
  return get(
    `${API_ROOT}/Accounts/${encodeURIComponent(creds.accountSid)}/Calls/${encodeURIComponent(callSid)}/Recordings.json`,
    creds,
  )
}

export function parseCallRecordings(body: unknown): { sid: string; durationSeconds: number | null }[] {
  const rows = (body as { recordings?: { sid?: unknown; duration?: unknown }[] })?.recordings
  if (!Array.isArray(rows)) return []
  return rows
    .filter((r) => typeof r.sid === 'string')
    .map((r) => {
      const d = Number.parseInt(String(r.duration ?? ''), 10)
      return { sid: r.sid as string, durationSeconds: Number.isFinite(d) ? d : null }
    })
}

/** The newest recording on the account — the media-auth probe needs one URL. */
export function buildLatestRecordingRequest(creds: TelephonyCredentials) {
  return get(`${API_ROOT}/Accounts/${encodeURIComponent(creds.accountSid)}/Recordings.json?PageSize=1`, creds)
}

/** Trust Hub business profiles on this account. */
export function buildCustomerProfilesRequest(creds: TelephonyCredentials) {
  return get('https://trusthub.twilio.com/v1/CustomerProfiles?PageSize=20', creds)
}

/** 'twilio-approved' when any profile is approved, else the newest profile's status. */
export function parseProfileStatus(body: unknown): string | null {
  const rows = (body as { results?: { status?: unknown; date_created?: unknown }[] })?.results
  if (!Array.isArray(rows) || rows.length === 0) return null
  const statuses = rows.filter((r) => typeof r.status === 'string')
  if (statuses.some((r) => r.status === 'twilio-approved')) return 'twilio-approved'
  const newest = [...statuses].sort((a, b) => String(b.date_created ?? '').localeCompare(String(a.date_created ?? '')))[0]
  return newest ? (newest.status as string) : null
}

/** The A2P campaign attached to ONE Messaging Service (per org). */
export function buildA2pStatusRequest(serviceSid: string, creds: TelephonyCredentials) {
  return get(`https://messaging.twilio.com/v1/Services/${encodeURIComponent(serviceSid)}/Compliance/Usa2p`, creds)
}

/** The campaign status, lower-cased; 'no campaign' when none is attached. */
export function parseA2pStatus(body: unknown): string | null {
  const rows = (body as { compliance?: { campaign_status?: unknown }[] })?.compliance
  if (!Array.isArray(rows) || rows.length === 0) return 'no campaign'
  const status = rows.map((r) => r.campaign_status).find((v): v is string => typeof v === 'string')
  return status ? status.toLowerCase() : null
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

  async listOwnedNumbers(creds: TelephonyCredentials): Promise<OwnedNumbersResult> {
    try {
      const numbers: OwnedNumber[] = []
      let next: string | null = null
      // Bounded: 20 pages of 1000 is far beyond any account here.
      for (let page = 0; page < 20; page += 1) {
        const { url, init } = buildListNumbersRequest(creds, next)
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
          const message = typeof body?.message === 'string' ? body.message : `Twilio API error (HTTP ${res.status}).`
          return { ok: false, error: message.slice(0, 500) }
        }
        const parsed = parseListNumbersResponse(await res.json().catch(() => null))
        numbers.push(...parsed.numbers)
        next = parsed.nextPageUri
        if (!next) break
      }
      return { ok: true, numbers }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Twilio request failed: ${detail}`.slice(0, 500) }
    }
  }

  async updateWebhooks(providerSid: string, webhooks: NumberWebhooks, creds: TelephonyCredentials): Promise<ReleaseResult> {
    try {
      const { url, init } = buildUpdateWebhooksRequest(providerSid, webhooks, creds)
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
      if (res.ok) return { ok: true }
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      const message = typeof body?.message === 'string' ? body.message : `Twilio API error (HTTP ${res.status}).`
      return { ok: false, error: message.slice(0, 500) }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Twilio request failed: ${detail}`.slice(0, 500) }
    }
  }
}
