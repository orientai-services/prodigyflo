/**
 * Reading the telephony server actions' answers on the client.
 *
 * The actions follow `NumberActionResult` (`{ ok: true, ... } | { ok: false,
 * error, code? }`), but the list and view-model actions return their payload
 * bare. One helper reads both, so a component never mistakes a refusal for an
 * empty list.
 */

export type ActionFailure = { ok: false; error: string; code?: string }

export function actionFailure(res: unknown): ActionFailure | null {
  if (res && typeof res === 'object' && 'ok' in res && (res as { ok: unknown }).ok === false) {
    const r = res as { error?: unknown; code?: unknown }
    return {
      ok: false,
      error: typeof r.error === 'string' && r.error ? r.error : 'That did not work. Try again.',
      code: typeof r.code === 'string' ? r.code : undefined,
    }
  }
  return null
}

/** Error text for a thrown action (network drop, server error). Never the raw stack. */
export function thrownMessage(err: unknown): string {
  if (err instanceof Error && err.message && !/fetch|network/i.test(err.message)) return err.message
  return 'Could not reach the server. Check the connection and try again.'
}

/** "2026-10-08T15:04:00Z" → "Oct 8, 3:04 pm" in the viewer's zone. */
export function whenLabel(iso: string | null | undefined): string {
  if (!iso) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return at
    .toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    .replace(' AM', ' am')
    .replace(' PM', ' pm')
}

/** 75 → "1:15". */
export function clockLabel(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
