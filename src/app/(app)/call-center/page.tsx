import { requireUser } from '@/lib/rbac'
import { CallCenterDesk } from './desk'
import { listLeads } from '@/lib/call-center/store'

export const metadata = { title: 'Call Center' }

export default async function CallCenterPage() {
  await requireUser()
  const leads = listLeads()
  return <CallCenterDesk initial={leads} />
}
