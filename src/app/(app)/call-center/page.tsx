import type { Metadata } from 'next'
import { CallCenter, type CallCenterPhone } from '@/components/call-center/call-center'
import { loadCallCenterDesk } from '@/lib/call-center/load-leads'
import { can, requireUser } from '@/lib/rbac'
import { getTwilioStatus, getVoiceSetup, listMissedCalls } from '@/lib/telephony/actions'
import type { MissedCallVM, TwilioStatusVM, VoiceSetup } from '@/lib/telephony/voice-contract'
import { loadPhoneSetup } from '@/lib/telephony/ui/phone-setup-data'

export const metadata: Metadata = { title: 'Call Center' }
export const dynamic = 'force-dynamic'

function one(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value
  return v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null
}

/**
 * Real Call Center rows when any exist. Dummy seed when the table is empty.
 *
 * The phone context loads beside the desk and never takes it down: a carrier
 * or settings read that fails leaves the desk working with the `tel:` flow
 * and an empty Missed tab.
 */
export default async function CallCenterPage({ searchParams }: PageProps<'/call-center'>) {
  const user = await requireUser()
  const params = await searchParams
  const owner = user.role === 'SUPER_ADMIN'

  const [desk, voice, missed, setup, status] = await Promise.all([
    loadCallCenterDesk(),
    getVoiceSetup().catch((): VoiceSetup => ({ ready: false, reason: "Phone calling isn't set up yet." })),
    listMissedCalls().catch(() => [] as MissedCallVM[]),
    owner ? loadPhoneSetup(user).catch(() => null) : Promise.resolve(null),
    owner ? getTwilioStatus(false).catch(() => null) : Promise.resolve(null),
  ])

  const phone: CallCenterPhone = {
    voiceNote: voice.ready ? null : voice.reason,
    missed: Array.isArray(missed) ? missed : [],
    openMissedId: one(params.missed),
    openLeadId: one(params.lead),
    canOverrideHours: can(user, 'telephony:manage'),
    setup: setup
      ? { vm: setup, status: status && 'account' in status ? (status as TwilioStatusVM) : null }
      : null,
  }

  return <CallCenter initialLeads={desk.leads} viewerId={desk.viewerId} phone={phone} />
}
