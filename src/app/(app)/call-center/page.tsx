import type { Metadata } from 'next'
import { CallCenter, type CallCenterPhone } from '@/components/call-center/call-center'
import { leadIdParam } from '@/lib/call-center/lead-link'
import { loadCallCenterDesk } from '@/lib/call-center/load-leads'
import { can, requireUser } from '@/lib/rbac'
import { getTwilioStatus, getVoiceSetup, listMissedCalls } from '@/lib/telephony/actions'
import type { MissedCallVM, TwilioStatusVM, VoiceSetup } from '@/lib/telephony/voice-contract'
import { loadPhoneSetup } from '@/lib/telephony/ui/phone-setup-data'
import { MetaAdsContent } from '@/app/(app)/marketing/meta/dashboard'

export const metadata: Metadata = { title: 'Call Center' }
export const dynamic = 'force-dynamic'

/** `?missed=` is a VoiceCall cuid. */
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
  // The Meta Ads dashboard lives under the desk's "Ads" tab, so the ad numbers
  // sit next to the leads they produced. Its views keep their own ?view=/?w=
  // and link back here (docs/META_ADS_SCS.md).
  const adsAllowed = can(user, 'connectors:read')
  const adsTab = adsAllowed && params.tab === 'ads'

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
    // Lead ids may be Meta ids ('meta:<org>:<leadgen>').
    openLeadId: leadIdParam(params.lead),
    canOverrideHours: can(user, 'telephony:manage'),
    setup: setup
      ? { vm: setup, status: status && 'account' in status ? (status as TwilioStatusVM) : null }
      : null,
  }

  // The Today ranking depends on the clock; the client starts from this one.
  const renderedAt = new Date().toISOString()

  return (
    <CallCenter
      initialLeads={desk.leads}
      viewerId={desk.viewerId}
      phone={phone}
      renderedAt={renderedAt}
      adsAllowed={adsAllowed}
      ads={adsTab ? <MetaAdsContent user={user} params={params} base="/call-center?tab=ads" embedded /> : null}
    />
  )
}
