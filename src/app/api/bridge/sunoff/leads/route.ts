import { bridgeJson, checkSignedRequest } from '@/lib/sunoff-bridge/files'
import { syncAssignedSunoffLeads } from '@/lib/sunoff-bridge/assigned'

export const maxDuration = 60
/** Full snapshots only; assignments are authoritative, retries are idempotent. */
export async function POST(request: Request) {
  if (Number(request.headers.get('content-length') ?? 0) > 1_500_000) return bridgeJson(413, { ok: false, error: 'too_large' })
  const text = await request.text()
  if (text.length > 1_500_000) return bridgeJson(413, { ok: false, error: 'too_large' })
  const refused = checkSignedRequest(request, text)
  if (refused) return refused
  let body: unknown
  try { body = JSON.parse(text) } catch { return bridgeJson(400, { ok: false, error: 'bad_json' }) }
  const result = await syncAssignedSunoffLeads(body)
  return bridgeJson(result.ok ? 200 : result.status, result)
}
