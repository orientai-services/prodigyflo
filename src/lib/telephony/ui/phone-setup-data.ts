import 'server-only'
import { db } from '@/lib/db'
import { can, type SessionUser } from '@/lib/rbac'
import { telephonySettingsFor } from '@/lib/telephony/settings'
import { credentialScope, isPlatformOwner } from '@/lib/telephony/tenancy'

/**
 * What the phone-setup screens need beyond the server actions' own answers:
 * who may do what, the organization list for number assignment (platform
 * owner only), and the account's consent-form map, which has no list action.
 *
 * Everything here is display-only. Every write goes through an action in
 * src/lib/telephony/actions.ts, which re-checks permission itself.
 */

export type PhoneSetupVM = {
  canManage: boolean
  canAdd: boolean
  /** Show "Sync numbers from Twilio": the platform owner, or a manager of an org on its own Twilio. */
  showSync: boolean
  /** Organizations a platform number can be assigned to. Empty unless platform owner. */
  organizations: { id: string; name: string }[]
  consentForms: { formId: string; textVersion: string }[]
}

export async function loadPhoneSetup(user: SessionUser): Promise<PhoneSetupVM> {
  const canManage = can(user, 'telephony:manage')
  const platformOwner = isPlatformOwner(user)

  const [settings, scope, organizations] = await Promise.all([
    telephonySettingsFor(user.organizationId),
    canManage && !platformOwner ? credentialScope(user.organizationId) : Promise.resolve(null),
    platformOwner
      ? db.organization.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } })
      : Promise.resolve([]),
  ])

  const consentForms = Object.entries(settings.consentForms)
    .map(([formId, textVersion]) => ({ formId, textVersion }))
    .sort((a, b) => a.formId.localeCompare(b.formId))

  return {
    canManage,
    canAdd: can(user, 'communications:send'),
    showSync: platformOwner || (canManage && scope?.kind === 'vault'),
    organizations,
    consentForms,
  }
}

/**
 * True when this org's texting registration (A2P) is last known approved.
 * Unknown counts as not approved, so the composer warns rather than promises.
 */
export async function textingRegistrationApproved(organizationId: string): Promise<boolean> {
  const status = (await telephonySettingsFor(organizationId)).a2p?.status
  return typeof status === 'string' && ['approved', 'verified', 'twilio-approved'].includes(status.toLowerCase())
}
