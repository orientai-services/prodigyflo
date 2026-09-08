import { emailDomain } from '@/lib/email-routing'

/**
 * Renders a user's email signature. Two voices:
 *  - formal:   full name, title, company, contact lines — for business outreach.
 *  - friendly: nickname-led and lighter — for warm client follow-ups.
 * The choice and phone inclusion are per-user profile settings.
 */

export type SignatureUser = {
  name: string
  nickname?: string | null
  title?: string | null
  phone?: string | null
  emailAlias?: string | null
  signatureStyle?: string | null
  signatureIncludePhone?: boolean | null
}

export function renderSignature(user: SignatureUser, organizationName: string): string {
  const friendly = user.signatureStyle === 'friendly'
  const displayName = friendly && user.nickname?.trim() ? user.nickname.trim() : user.name
  const address = user.emailAlias ? `${user.emailAlias}@${emailDomain()}` : null

  const lines: string[] = []
  if (friendly) {
    lines.push(`— ${displayName}`)
    const context = [user.title?.trim(), organizationName].filter(Boolean).join(' · ')
    if (context) lines.push(context)
  } else {
    lines.push(displayName)
    if (user.title?.trim()) lines.push(user.title.trim())
    lines.push(organizationName)
  }
  if (user.signatureIncludePhone !== false && user.phone?.trim()) lines.push(user.phone.trim())
  if (address) lines.push(address)

  return lines.join('\n')
}
