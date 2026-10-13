import { createHmac } from 'node:crypto'

/**
 * The chat SSO token ProdigyFlo mints (HS256, header kid "pf"). The chat
 * Worker verifies it with PF_CHAT_KEY, accepts it for host "prodigyflo" only,
 * and takes role, staff, name and company from SunOff's org sync, never from
 * here. So the token carries the least it can: who (sub = the linked SunOff
 * user), a display name, the profile photo's URL when there is one, the
 * language, and a lifetime of at most 12 hours.
 */

export const CHAT_TOKEN_TTL_SECONDS = 11 * 3600

const b64u = (value: Buffer | string) =>
  Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export type ChatTokenInput = {
  sunoffUserId: number
  pfUserId: string
  name: string
  lang: 'en' | 'es'
  /** The user's profile photo as an absolute app URL (chatPictureUrl), or null for none. */
  picture?: string | null
}

/** The only origin a `picture` claim may point at: the chat Worker shows it to teammates as-is. */
export const CHAT_PICTURE_ORIGIN = 'https://www.prodigyflo.ai'

/**
 * User.avatarUrl → the absolute URL the chat shows. The app stores its own
 * served path (`/api/profile/avatar/<id>.<ext>?v=N`) and renders it relative
 * to the page, so the chat gets the same path on the production origin. An
 * absolute URL passes only when it is already on that origin; anything else
 * (another host, `//x`, `data:`) is left out rather than sent to the Worker.
 */
export function chatPictureUrl(avatarUrl: string | null | undefined): string | null {
  const v = (avatarUrl ?? '').trim()
  if (!v) return null
  if (v.startsWith('/') && !v.startsWith('//') && !v.includes('\\')) return CHAT_PICTURE_ORIGIN + v
  return v.startsWith(CHAT_PICTURE_ORIGIN + '/') ? v : null
}

/** "Gatsby Rep" → "Gatsby R." (the hosts never send an email as a name). */
export function chatDisplayName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 'ProdigyFlo'
  const first = parts[0].slice(0, 60)
  return parts.length > 1 ? `${first} ${parts[parts.length - 1][0].toUpperCase()}.` : first
}

export function mintChatToken(key: string, input: ChatTokenInput, now = Date.now()): string {
  if (!Number.isInteger(input.sunoffUserId) || input.sunoffUserId <= 0) throw new Error('A SunOff user id is required')
  const iat = Math.floor(now / 1000)
  const claims = {
    sub: `u${input.sunoffUserId}`,
    name: chatDisplayName(input.name),
    // Required by the token schema; the Worker ignores it for this host.
    role: 'rep',
    company_id: null,
    lang: input.lang,
    host: 'prodigyflo',
    host_ref: input.pfUserId,
    // Omitted (not null) without a photo: the Worker then keeps showing initials.
    ...(input.picture ? { picture: input.picture } : {}),
    iat,
    exp: iat + CHAT_TOKEN_TTL_SECONDS,
  }
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'pf' }))
  const body = b64u(JSON.stringify(claims))
  const sig = b64u(createHmac('sha256', key).update(`${head}.${body}`, 'utf8').digest())
  return `${head}.${body}.${sig}`
}
