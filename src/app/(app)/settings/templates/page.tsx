import { db } from '@/lib/db'
import { clientScope, requirePermissionPage } from '@/lib/rbac'
import { isMockMode } from '@/lib/messaging'
import { PageHeader } from '@/components/page-header'
import { TemplatesManager } from './templates-manager'

export const metadata = { title: 'Message templates' }

export default async function TemplatesPage() {
  const user = await requirePermissionPage('connectors:manage')

  const [templates, clients] = await Promise.all([
    db.messageTemplate.findMany({
      where: { organizationId: user.organizationId },
      orderBy: [{ name: 'asc' }, { locale: 'asc' }],
      select: {
        id: true,
        key: true,
        name: true,
        channel: true,
        locale: true,
        subject: true,
        body: true,
        description: true,
        isActive: true,
        updatedAt: true,
        createdBy: { select: { name: true } },
      },
    }),
    db.client.findMany({
      where: clientScope(user),
      orderBy: { lastActivityAt: 'desc' },
      take: 50,
      select: { id: true, firstName: true, lastName: true, preferredLanguage: true },
    }),
  ])

  return (
    <>
      <PageHeader
        title="Message templates"
        description="Reusable email and SMS templates with {{variable}} placeholders, previewed against a real client before anything is sent."
      />
      <div className="p-4 sm:p-6">
        <TemplatesManager
          templates={templates.map((t) => ({
            ...t,
            channel: t.channel as 'EMAIL' | 'SMS',
            updatedAt: t.updatedAt.toISOString(),
            createdByName: t.createdBy?.name ?? null,
          }))}
          clients={clients.map((c) => ({
            id: c.id,
            name: `${c.firstName} ${c.lastName}`,
            locale: c.preferredLanguage,
          }))}
          mock={{ EMAIL: isMockMode('EMAIL'), SMS: isMockMode('SMS') }}
        />
      </div>
    </>
  )
}
