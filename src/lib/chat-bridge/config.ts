import 'server-only'

/**
 * ProdigyFlo as a host of the one SunOff team chat (docs/CYS_BRIDGE.md §B4,
 * owner decision D4: a native ProdigyFlo screen on the chat's own API, never a
 * second store). One shared secret, PF_CHAT_KEY, held here and as a secret of
 * the chat Worker; it mints PF chat sessions (no elevated role), signs the
 * case feed and case-sms in both directions, and nothing else.
 */

export const DEFAULT_CHAT_BASE = 'https://chat.sunoff.app'

export function chatKey(): string | null {
  const key = process.env.PF_CHAT_KEY?.trim() ?? ''
  return key.length >= 32 ? key : null
}

/** The chat Worker's origin. Overridable for a local `wrangler dev`. */
export function chatBase(): string {
  const raw = process.env.CHAT_BASE_URL?.trim()
  if (raw && /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(raw)) return raw.replace(/\/+$/, '')
  return DEFAULT_CHAT_BASE
}
