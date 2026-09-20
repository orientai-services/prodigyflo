import { finalDeskEnabled } from '@/lib/final-desk/data'
import { FinalDeskPage } from '@/components/final-desk/page'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/rbac'
import { canReadDesk } from '@/lib/daily-desk-data'
import { loadDeskQueue } from '@/lib/daily-desk-queue-data'
import { DeskQueueView } from './desk-queue'

export const metadata = { title: 'Queue' }

export default async function QueuePage() {
  if (finalDeskEnabled()) return <FinalDeskPage view="queue" />
  const user = await requireUser()
  if (!canReadDesk(user)) redirect('/forbidden')

  const queue = await loadDeskQueue(user)
  return <DeskQueueView queue={queue} />
}
