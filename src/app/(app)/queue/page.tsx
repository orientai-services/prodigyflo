import { redirect } from 'next/navigation'
import { canAny, requireUser } from '@/lib/rbac'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'

export const metadata = { title: 'Queue' }

export default async function QueuePage() {
  const user = await requireUser()
  if (
    !canAny(user, ['clients:read_assigned', 'clients:read_team', 'clients:read_region', 'clients:read_all'])
  ) {
    redirect('/forbidden')
  }

  return (
    <>
      <PageHeader
        title="Queue"
        description="Human work only. Unverified extraction and booked files with no contract land here in a later milestone."
      />
      <EmptyState
        icon="ListTodo"
        title="Nothing in the queue yet"
        description="This rail stop is live. The work list wires up after the case file."
      />
    </>
  )
}
