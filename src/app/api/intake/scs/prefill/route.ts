import { db } from '@/lib/db'
import { verifyIntakeToken } from '@/lib/call-center/intake-link'
import { readSecret } from '@/lib/call-center/contact'
import { readFacebookFormEvent } from '@/lib/call-center/meta-route'
import { sourceMeta, sunoffActive } from '@/lib/sunoff-bridge/assigned-model'

const answer = (status: number, body: unknown) => Response.json(body, { status, headers: {
  'cache-control': 'no-store, private', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex',
} })
/** Server-to-server SCS bootstrap. The link token authorizes exactly one lead, expires in 14 days,
 * and stays in the POST body. No consent, signatures, appointments or testimony are invented.
 */
export async function POST(request: Request) {
  const text = await request.text()
  if (text.length > 1000) return answer(413, { ok: false })
  let token: unknown
  try { token = JSON.parse(text).token } catch { return answer(400, { ok: false }) }
  const checked = verifyIntakeToken(token)
  if (!checked.ok) return answer(401, { ok: false })
  const row = await db.callCenterLead.findUnique({ where: { id: checked.leadId }, include: {
    events: { where: { type: 'FORM' }, orderBy: { createdAt: 'asc' }, take: 1 },
  } })
  if (!row || !sunoffActive(row.leadAttribution) || row.doNotCallAt || row.clientId) return answer(404, { ok: false })
  const m = sourceMeta(row.leadAttribution), form = readFacebookFormEvent(row.events[0]?.body ?? '')
  const name = typeof m?.name === 'string' ? m.name : form.name
  const address = typeof m?.address === 'string' ? m.address : null
  const parts = address?.match(/^(.*),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/i)
  const words = name?.trim().split(/\s+/) ?? []
  const values = { full_name: name, first_name: words[0] || null, last_name: words.slice(1).join(' ') || null,
    phone: readSecret(row.phoneSecret), email: readSecret(row.emailSecret), address,
    address_line1: parts?.[1] ?? null, city: parts?.[2]?.trim() ?? null, state: parts?.[3]?.toUpperCase() ?? null,
    zip: parts?.[4] ?? form.zip }
  return answer(200, { ok: true, version: 1, leadId: row.id, language: row.language,
    values: Object.fromEntries(Object.entries(values).filter(([,v]) => v != null && v !== '')) })
}
