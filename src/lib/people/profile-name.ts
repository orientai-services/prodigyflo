const EMAIL = /^[^\s@]+@[^\s@]+$/

/**
 * The name to show for a staff member: their nickname, else their profile name,
 * never an email address. Some accounts were invited with the email typed into
 * the name field; for those, "gatsby.smith@x.com" shows as "Gatsby Smith".
 */
export function profileName(user: { name?: string | null; nickname?: string | null; email?: string | null }): string | null {
  for (const raw of [user.nickname, user.name]) {
    const v = (raw ?? '').trim()
    if (v && !EMAIL.test(v)) return v
  }
  const email = [user.name, user.email].map((v) => (v ?? '').trim()).find((v) => EMAIL.test(v))
  if (!email) return null
  const words = email
    .split('@')[0]
    .split(/[._+\-\d]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
  return words.length ? words.join(' ') : null
}

/** Up to two letters for a round avatar: first and last word of the shown name, "?" when there is none. */
export function profileInitials(name: string | null | undefined): string {
  const parts = (name ?? '').replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  const first = parts[0][0] ?? ''
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : ''
  return (first + last).toUpperCase()
}
