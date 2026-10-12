import { applySunoffStatus } from '@/lib/sunoff-bridge/status'
import { BRIDGE_SIG_HEADER } from '@/lib/sunoff-bridge/sign'
import { bridgeJson, checkSignedRequest, idempotencyKeyOf } from '@/lib/sunoff-bridge/files'

/** 16 KB is far more than a status body needs. */
const MAX_BODY = 16 * 1024

/**
 * SunOff's signed status hook: { pf_lead_id, sunoff_lead_id, status, at, detail? }
 * with status standby | started | submitted | withdrawn. Monotonic; the identical
 * signed request within 24 h is refused as a replay (docs/CYS_BRIDGE.md §B3.2, §B3.3).
 */
export async function POST(request: Request) {
  const text = await request.text()
  if (text.length > MAX_BODY) return bridgeJson(413, { ok: false, error: 'too_large', message: 'Body too large.' })
  const refused = checkSignedRequest(request, text)
  if (refused) return refused
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return bridgeJson(400, { ok: false, error: 'bad_json', message: 'Body must be JSON.' })
  }
  const result = await applySunoffStatus(body, idempotencyKeyOf(request), request.headers.get(BRIDGE_SIG_HEADER) ?? '')
  if (!result.ok) return bridgeJson(result.httpStatus, { ok: false, error: result.error, message: result.message })
  return bridgeJson(200, { ok: true, status: result.status.toLowerCase(), changed: result.changed })
}
