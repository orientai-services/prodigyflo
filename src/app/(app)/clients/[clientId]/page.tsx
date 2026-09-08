import Link from 'next/link'
import { notFound } from 'next/navigation'
import { can, canAny, findClientInScope, requireUser } from '@/lib/rbac'
import { ASSIGNMENT_PANEL_PERMISSIONS } from '@/lib/assignment'
import { cn } from '@/lib/utils'
import { ClientHeader } from '@/components/client/client-header'
import { DuplicateBanner } from '@/components/client/duplicate-banner'
import { OverviewTab } from '@/components/client/overview-tab'
import { TimelineTab } from '@/components/client/timeline-tab'
import { TasksNotesTab } from '@/components/client/tasks-notes-tab'
import { CommunicationsTab } from '@/components/client/communications-tab'
import { DocumentsTab } from '@/components/client/documents-tab'
import { CysTab } from '@/components/client/cys-tab'
import { CloseOpsStrip, CloserBriefSection } from './closeops-section'
import { AssignmentPanel } from './assignment-panel'
import { NurturePanel } from '@/components/client/nurture-panel'
import { LogCallButton } from '@/components/client/log-call-dialog'

export const metadata = { title: 'Client' }

const TAB_KEYS = ['overview', 'timeline', 'tasks', 'communications', 'documents', 'cys'] as const
type TabKey = (typeof TAB_KEYS)[number]

const TAB_LABELS: Record<TabKey, string> = {
  overview: 'Overview',
  timeline: 'Timeline',
  tasks: 'Tasks & notes',
  communications: 'Communications',
  documents: 'Documents',
  cys: 'CYS readiness',
}

export default async function ClientDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requireUser()
  const { clientId } = await params
  const sp = await searchParams

  const client = await findClientInScope(user, clientId)
  if (!client) notFound()

  const visible = TAB_KEYS.filter((key) => {
    if (key === 'communications') return can(user, 'communications:read')
    if (key === 'documents') return can(user, 'documents:read')
    if (key === 'cys') return can(user, 'submissions:read')
    return true
  })

  const requested = typeof sp.tab === 'string' ? (sp.tab as TabKey) : 'overview'
  const tab: TabKey = visible.includes(requested) ? requested : 'overview'
  const timelineLimit = Math.min(500, Math.max(25, Number(sp.tlimit) || 25))

  return (
    <>
      <ClientHeader clientId={clientId} />
      <CloseOpsStrip clientId={clientId} />
      <DuplicateBanner clientId={clientId} />

      <nav className="scroll-x border-b px-4 sm:px-6" aria-label="Client record sections">
        <div className="flex gap-1">
          {visible.map((key) => (
            <Link
              key={key}
              href={`/clients/${clientId}${key === 'overview' ? '' : `?tab=${key}`}`}
              scroll={false}
              aria-current={tab === key ? 'page' : undefined}
              className={cn(
                'border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors',
                tab === key
                  ? 'border-primary text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground border-transparent',
              )}
            >
              {TAB_LABELS[key]}
            </Link>
          ))}
        </div>
      </nav>

      <div className="px-4 py-5 sm:px-6">
        {tab === 'overview' && (
          <div className="space-y-4">
            {can(user, 'communications:send') && (
              <div className="flex justify-end">
                <LogCallButton clientId={clientId} />
              </div>
            )}
            <CloserBriefSection clientId={clientId} />
            <div className="grid items-start gap-4 lg:grid-cols-2">
              {canAny(user, [...ASSIGNMENT_PANEL_PERMISSIONS]) && <AssignmentPanel clientId={clientId} />}
              <NurturePanel clientId={clientId} user={user} />
            </div>
            <OverviewTab clientId={clientId} />
          </div>
        )}
        {tab === 'timeline' && <TimelineTab clientId={clientId} limit={timelineLimit} />}
        {tab === 'tasks' && <TasksNotesTab clientId={clientId} />}
        {tab === 'communications' && <CommunicationsTab clientId={clientId} />}
        {tab === 'documents' && <DocumentsTab clientId={clientId} />}
        {tab === 'cys' && <CysTab clientId={clientId} />}
      </div>
    </>
  )
}
