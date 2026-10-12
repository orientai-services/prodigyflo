import { createHmac } from 'node:crypto'

/**
 * The chat SSO token ProdigyFlo mints (HS256, header kid "pf"). The chat
 * Worker verifies it with PF_CHAT_KEY, accepts it for host "prodigyflo" only,
 * and takes role, staff, name and company from SunOff's org sync, never from
 * here. So the token carries the least it can: who (sub = the linked SunOff
 * user), a display name, the language, and a lifetime of at most 12 hours.
 */

export const CHAT_TOKEN_TTL_SECONDS = 11 * 3600

const b64u = (value: Buffer | string) =>
  Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export type ChatTokenInput = {
  sunoffUserId: number
  pfUserId: string
  name: string
  lang: 'en' | 'es'
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
    iat,
    exp: iat + CHAT_TOKEN_TTL_SECONDS,
  }
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'pf' }))
  const body = b64u(JSON.stringify(claims))
  const sig = b64u(createHmac('sha256', key).update(`${head}.${body}`, 'utf8').digest())
  return `${head}.${body}.${sig}`
}
