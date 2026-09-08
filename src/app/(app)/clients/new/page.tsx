import { db } from '@/lib/db'
import { requirePermissionPage, userScope } from '@/lib/rbac'
import { PageHeader } from '@/components/page-header'
import { NewClientForm } from './new-client-form'

export const metadata = { title: 'New client' }

export default async function NewClientPage() {
  const user = await requirePermissionPage('clients:create')

  const [owners, leadSources] = await Promise.all([
    db.user.findMany({
      where: { ...userScope(user), isActive: true, role: { key: { notIn: ['CLIENT'] } } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    db.leadSource.findMany({
      where: { organizationId: user.organizationId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ])

  return (
    <>
      <PageHeader
        title="New client"
        description="Duplicate detection runs before the record is created."
      />
      <NewClientForm
        owners={owners.map((o) => ({ value: o.id, label: o.name }))}
        leadSources={leadSources.map((s) => ({ value: s.id, label: s.name }))}
      />
    </>
  )
}
