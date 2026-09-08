import { db } from '@/lib/db'
import { can, canSeeInternal, requireUser, requireClientInScope, userScope } from '@/lib/rbac'
import { dateTime, humanize, relativeTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/empty-state'
import { cn } from '@/lib/utils'
import { NewTaskForm, NoteForm, TaskControls } from '@/app/(app)/clients/[clientId]/task-forms'

const PRIORITY_STYLE: Record<string, string> = {
  URGENT: 'text-danger',
  HIGH: 'text-warning',
  NORMAL: 'text-muted-foreground',
  LOW: 'text-muted-foreground',
}

export async function TasksNotesTab({ clientId }: { clientId: string }) {
  const user = await requireUser()
  await requireClientInScope(user, clientId)

  const internalOk = canSeeInternal(user)
  const canEdit = can(user, 'clients:update')

  const [tasks, notes, assignees] = await Promise.all([
    db.task.findMany({
      where: { clientId },
      orderBy: [{ status: 'asc' }, { dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      include: {
        assignee: { select: { id: true, name: true } },
        createdBy: { select: { name: true } },
      },
    }),
    db.note.findMany({
      where: { clientId, ...(internalOk ? {} : { isInternal: false }) },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      include: { author: { select: { name: true } } },
    }),
    canEdit
      ? db.user.findMany({
          where: { ...userScope(user), isActive: true, role: { key: { notIn: ['CLIENT'] } } },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        })
      : Promise.resolve([]),
  ])

  const assigneeOptions = assignees.map((a) => ({ value: a.id, label: a.name }))
  const now = new Date().getTime()

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <section className="lg:col-span-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">
            Tasks{' '}
            <span className="text-muted-foreground font-normal">
              ({tasks.filter((t) => t.status !== 'COMPLETED' && t.status !== 'CANCELLED').length} open)
            </span>
          </h3>
          {canEdit && tasks.length > 0 && <span />}
        </div>

        {canEdit && (
          <div className="mt-2">
            <NewTaskForm clientId={clientId} assignees={assigneeOptions} />
          </div>
        )}

        {tasks.length === 0 ? (
          <EmptyState icon="ListTodo" title="No tasks yet" description="Create the first follow-up for this client." />
        ) : (
          <ul className="mt-3 space-y-2">
            {tasks.map((task) => {
              const done = task.status === 'COMPLETED'
              const overdue = !done && task.dueAt && task.dueAt.getTime() < now
              return (
                <li key={task.id} className="bg-card rounded-lg border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className={cn('text-sm font-medium', done && 'text-muted-foreground line-through')}>
                        {task.title}
                      </p>
                      {task.description && (
                        <p className="text-muted-foreground mt-0.5 text-xs whitespace-pre-wrap">{task.description}</p>
                      )}
                      <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                        <span className={cn('font-medium', PRIORITY_STYLE[task.priority])}>
                          {humanize(task.priority)}
                        </span>
                        <span>· {task.assignee ? task.assignee.name : 'Unassigned'}</span>
                        {task.dueAt && (
                          <span className={cn(overdue && 'text-danger font-medium')}>
                            · due {dateTime(task.dueAt)}
                            {overdue ? ' (overdue)' : ''}
                          </span>
                        )}
                        {done && task.completedAt && <span>· completed {relativeTime(task.completedAt)}</span>}
                        {task.status === 'CANCELLED' && <Badge variant="outline">Cancelled</Badge>}
                      </p>
                    </div>
                    {canEdit && (
                      <TaskControls
                        clientId={clientId}
                        taskId={task.id}
                        status={task.status}
                        assigneeId={task.assignee?.id ?? ''}
                        dueAt={task.dueAt ? task.dueAt.toISOString().slice(0, 16) : ''}
                        assignees={assigneeOptions}
                      />
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="lg:col-span-2">
        <h3 className="text-sm font-medium">Notes</h3>
        {canEdit && (
          <div className="mt-2">
            <NoteForm clientId={clientId} canInternal={internalOk} />
          </div>
        )}
        {notes.length === 0 ? (
          <EmptyState icon="StickyNote" title="No notes yet" />
        ) : (
          <ul className="mt-3 space-y-2">
            {notes.map((note) => (
              <li key={note.id} className="bg-card rounded-lg border p-3">
                <p className="text-sm whitespace-pre-wrap">{note.body}</p>
                <p className="text-muted-foreground mt-1.5 flex items-center gap-1.5 text-xs">
                  {note.author?.name ?? 'Unknown'} · {relativeTime(note.createdAt)}
                  {note.isInternal ? (
                    <Badge variant="ghost">Internal</Badge>
                  ) : (
                    <Badge variant="outline">Client-visible</Badge>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
