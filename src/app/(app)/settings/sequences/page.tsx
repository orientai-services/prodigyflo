import { db } from '@/lib/db'
import { can, requirePermissionPage } from '@/lib/rbac'
import { PageHeader } from '@/components/page-header'
import { SequencesManager } from './sequences-manager'

export const metadata = { title: 'Sequences' }

export default async function SequencesPage() {
  const user = await requirePermissionPage('connectors:read')
  const canManage = can(user, 'connectors:manage')

  const [sequences, templates, pipeline] = await Promise.all([
    db.sequence.findMany({
      where: { organizationId: user.organizationId },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: {
        steps: { orderBy: { position: 'asc' } },
        _count: { select: { enrollments: true } },
        enrollments: { where: { status: 'ACTIVE' }, select: { id: true } },
      },
    }),
    db.messageTemplate.findMany({
      where: { organizationId: user.organizationId, isActive: true, channel: { in: ['EMAIL', 'SMS'] } },
      orderBy: [{ name: 'asc' }, { locale: 'asc' }],
      select: { key: true, name: true, channel: true },
    }),
    db.pipeline.findFirst({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: 'asc' },
      include: { stages: { orderBy: { position: 'asc' }, select: { key: true, name: true } } },
    }),
  ])

  // One picker entry per template key + channel (locales collapse together).
  const templateOptions = [
    ...new Map(templates.map((t) => [`${t.channel}:${t.key}`, { key: t.key, name: t.name, channel: t.channel as 'EMAIL' | 'SMS' }])).values(),
  ]

  return (
    <>
      <PageHeader
        title="Sequences"
        description="Automated follow-up: ordered, delayed template sends that stop the moment a client replies. Consent is re-checked before every message."
      />
      <div className="p-4 sm:p-6">
        <SequencesManager
          canManage={canManage}
          sequences={sequences.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            isActive: s.isActive,
            triggerStageKey: s.triggerStageKey,
            steps: s.steps.map((st) => ({
              delayHours: st.delayHours,
              channel: st.channel as 'EMAIL' | 'SMS',
              templateKey: st.templateKey,
              stopIfReplied: st.stopIfReplied,
            })),
            totalEnrollments: s._count.enrollments,
            activeEnrollments: s.enrollments.length,
          }))}
          templates={templateOptions}
          stages={pipeline?.stages ?? []}
        />
      </div>
    </>
  )
}
