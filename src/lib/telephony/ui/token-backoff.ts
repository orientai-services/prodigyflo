/**
 * How long the browser phone waits before asking for a fresh voice token
 * again after Twilio refused one: 2 s, 4 s, 8 s … capped at 60 s, plus up to
 * 10% jitter so tabs that failed together don't retry together. Without it a
 * refused token was re-requested several times a second per tab.
 */
export const TOKEN_RETRY_BASE_MS = 2_000
export const TOKEN_RETRY_MAX_MS = 60_000
export const TOKEN_RETRY_JITTER = 0.1

/** `attempt` counts consecutive refusals from 0; `random` is in [0, 1). */
export function tokenRetryDelay(attempt: number, random: number = Math.random()): number {
  const n = Math.max(0, Math.floor(attempt))
  const base = Math.min(TOKEN_RETRY_MAX_MS, TOKEN_RETRY_BASE_MS * 2 ** Math.min(n, 30))
  const jitter = Math.min(Math.max(random, 0), 1) * TOKEN_RETRY_JITTER * base
  return Math.round(base + jitter)
}
