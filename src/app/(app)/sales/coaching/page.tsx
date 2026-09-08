import Link from 'next/link'
import { Download, GraduationCap, PhoneCall } from 'lucide-react'
import {
  SALES_LEVEL_LABEL,
  canCoach,
  getCoachingRollups,
  listCoachableClosers,
  listCoachingNotes,
  listRecentClientsForCoaching,
  requireSalesAccess,
} from '@/lib/coaching'
import { can } from '@/lib/rbac'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { fullName, number, relativeTime } from '@/lib/format'
import { SalesNav } from '../ui'
import { CoachingDialog } from './coaching-dialog'

export const metadata = { title: 'Coaching & call QA' }

function qaTone(avg: number): string {
  if (avg >= 8) return 'text-success'
  if (avg >= 6) return 'text-warning'
  return 'text-danger'
}

export default async function CoachingPage() {
  const { user, level } = await requireSalesAccess()
  const manager = canCoach(user)
  const canQualify = can(user, 'qualification:review')

  const [notes, rollups, closers, clients] = await Promise.all([
    listCoachingNotes(user),
    getCoachingRollups(user),
    manager ? listCoachableClosers(user) : Promise.resolve([]),
    manager ? listRecentClientsForCoaching(user) : Promise.resolve([]),
  ])

  return (
    <>
      <PageHeader
        title="Coaching & call QA"
        description={
          manager
            ? `Weekly 1-on-1s and call scores for the ${SALES_LEVEL_LABEL[level]} — the Phase rhythm's coaching leg`
            : 'Coaching notes and call scores written about you — your managers keep these current'
        }
        actions={
          <>
            <Button variant="outline" size="sm" render={<a href="/exports/coaching" />}>
              <Download className="size-3.5" />
              Export CSV
            </Button>
            {manager && <CoachingDialog closers={closers} clients={clients} />}
          </>
        }
      >
        <SalesNav current="coaching" canQualify={canQualify} />
      </PageHeader>

      <div className="space-y-4 p-4 sm:p-6">
        {/* Per-closer rollup chips */}
        {manager && closers.length > 0 && (
          <div className="bg-card shadow-e1 rounded-xl border">
            <div className="border-b px-4 py-3">
              <h2 className="text-sm font-semibold">Closer rollup</h2>
              <p className="text-muted-foreground text-xs">
                QA average across all scored calls · sessions of any kind this month
              </p>
            </div>
            <div className="flex flex-wrap gap-2 p-4">
              {closers.map((c) => {
                const r = rollups.get(c.id)
                return (
                  <div
                    key={c.id}
                    className="bg-surface-sunk/50 flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm"
                  >
                    <span className="font-medium">{c.name}</span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      QA{' '}
                      {r?.qaAvg != null ? (
                        <span className={cn('font-semibold', qaTone(r.qaAvg))}>
                          {r.qaAvg.toFixed(1)}/10
                        </span>
                      ) : (
                        '—'
                      )}
                      <span aria-hidden> · </span>
                      {number(r?.monthCount ?? 0)} this month
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Notes feed */}
        <div className="bg-card shadow-e1 rounded-xl border">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">
              {manager ? 'Recent notes' : 'Notes about you'}
            </h2>
            <p className="text-muted-foreground text-xs">
              Newest first · closers always see what is written about them
            </p>
          </div>
          {notes.length === 0 ? (
            <EmptyState
              icon="GraduationCap"
              title="No coaching notes yet"
              description={
                manager
                  ? 'Log the weekly 1-on-1s and score calls here — the rollup builds itself as you go.'
                  : 'When a manager logs a 1-on-1 or scores one of your calls, it appears here.'
              }
            />
          ) : (
            <ul className="divide-y">
              {notes.map((note) => (
                <li key={note.id} className="px-4 py-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    {note.kind === 'CALL_QA' ? (
                      <Badge variant="secondary">
                        <PhoneCall data-slot="icon" /> Call QA
                      </Badge>
                    ) : (
                      <Badge variant="outline">
                        <GraduationCap data-slot="icon" /> 1-on-1
                      </Badge>
                    )}
                    <span className="text-sm font-medium">{note.subject.name}</span>
                    {note.kind === 'CALL_QA' && note.score !== null && (
                      <span
                        className={cn('text-sm font-semibold tabular-nums', qaTone(note.score))}
                      >
                        {note.score}/10
                      </span>
                    )}
                    {note.client && (
                      <Link
                        href={`/clients/${note.client.id}`}
                        className="text-primary text-xs hover:underline"
                      >
                        re: {fullName(note.client)}
                      </Link>
                    )}
                    <span className="text-muted-foreground ml-auto text-xs">
                      {note.author.name} · {relativeTime(note.createdAt)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm whitespace-pre-wrap">{note.body}</p>
                  {(note.strengths || note.improvements) && (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {note.strengths && (
                        <div className="bg-success/5 border-success/20 rounded-lg border px-3 py-2">
                          <p className="text-success text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                            Strengths
                          </p>
                          <p className="mt-0.5 text-sm">{note.strengths}</p>
                        </div>
                      )}
                      {note.improvements && (
                        <div className="bg-warning/5 border-warning/20 rounded-lg border px-3 py-2">
                          <p className="text-warning text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                            Improvements
                          </p>
                          <p className="mt-0.5 text-sm">{note.improvements}</p>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  )
}
