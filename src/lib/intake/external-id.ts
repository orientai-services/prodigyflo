import { createHash } from 'node:crypto'
import { canonicalize, getPath } from '@/lib/intake/mapping'

/**
 * The idempotency key for a webhook delivery: an explicit id when the sender
 * provides one, otherwise a content hash of the canonicalised body so an exact
 * replay maps onto the same IntakeSubmission row.
 *
 * Lives apart from mapping.ts because node:crypto must stay out of the client
 * bundle that imports the mapping helpers.
 *
 * `preferredKey` (the connector def's externalIdKey — e.g. GoHighLevel's
 * `contact_id`, Meta's `leadgen_id`) is checked FIRST so a source's own stable
 * id wins the idempotency key over the generic fallbacks below.
 */
export function deriveExternalId(payload: unknown, preferredKey?: string | null): string {
  const paths = preferredKey?.trim()
    ? [preferredKey.trim(), 'event_id', 'submission_id', 'entry.id', 'id']
    : ['event_id', 'submission_id', 'entry.id', 'id']
  for (const path of paths) {
    const v = getPath(payload, path)
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return `sha256:${createHash('sha256').update(canonicalize(payload)).digest('hex')}`
}
