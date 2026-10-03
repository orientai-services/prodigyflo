import type { Metadata } from 'next'
import { CallCenter } from '@/components/call-center/call-center'
import { loadCallCenterDesk } from '@/lib/call-center/load-leads'

export const metadata: Metadata = { title: 'Call Center' }
export const dynamic = 'force-dynamic'

/** Real Call Center rows when any exist. Dummy seed when the table is empty. */
export default async function CallCenterPage() {
  const desk = await loadCallCenterDesk()
  return <CallCenter initialLeads={desk.leads} viewerId={desk.viewerId} />
}
