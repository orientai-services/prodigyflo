import Link from 'next/link'
import { AlertTriangle, ArrowRight, FileCheck2, Filter, Megaphone, Send } from 'lucide-react'
import { requireUser } from '@/lib/rbac'
import { getFunnel } from '@/lib/analytics'
import {
  LEVEL_LABEL,
  getDocumentCompletion,
  getOverdueSummary,
  getSubmissionStatusBreakdown,
  requireAnalyticsLevel,
} from '@/lib/reporting'
import { PageHeader } from '@/components/page-header'
import { number, percent, rate } from '@/lib/format'

export const metadata = { title: 'Reports' }

export default async function ReportsIndexPage() {
  const user = await requireUser()
  const level = requireAnalyticsLevel(user)

  const [docs, submissions, funnel, overdue] = await Promise.all([
    getDocumentCompletion(user),
    getSubmissionStatusBreakdown(user),
    getFunnel(user),
    getOverdueSummary(user),
  ])

  const docRequested = docs.reduce((s, d) => s + d.requested, 0)
  const docApproved = docs.reduce((s, d) => s + d.approved, 0)
  const docApprovalRate = rate(docApproved, docRequested)
  const submissionsTotal = submissions.reduce((s, r) => s + r.count, 0)
  const submissionsApproved = submissions.find((s) => s.status === 'APPROVED')?.count ?? 0
  const leads = funnel[0]?.count ?? 0
  const won = funnel[funnel.length - 1]?.count ?? 0
  const overdueTotal = overdue.overdueTasks + overdue.slaExpired

  const REPORTS = [
    {
      href: '/reports/overdue',
      icon: AlertTriangle,
      title: 'Overdue follow-ups',
      description: 'Tasks past due and clients sitting past their stage SLA with nobody touching them.',
      stat: overdueTotal === 0 ? 'All caught up' : `${number(overdueTotal)} need attention`,
      urgent: overdueTotal > 0,
    },
    {
      href: '/reports/conversion',
      icon: Filter,
      title: 'Conversion funnel',
      description: 'Where clients drop out between first contact and a closed deal, stage by stage.',
      stat: `${number(leads)} leads → ${number(won)} won`,
      urgent: false,
    },
    {
      href: '/reports/documents',
      icon: FileCheck2,
      title: 'Document completion',
      description: 'Requested vs. received vs. approved for every document requirement.',
      stat: docRequested === 0 ? 'No documents requested yet' : `${percent(docApprovalRate, 0)} approved overall`,
      urgent: false,
    },
    {
      href: '/reports/submissions',
      icon: Send,
      title: 'CYS submissions',
      description: 'Submission volume over time and where every package sits right now.',
      stat:
        submissionsTotal === 0
          ? 'No submissions yet'
          : `${number(submissionsTotal)} total · ${number(submissionsApproved)} approved`,
      urgent: false,
    },
    {
      href: '/reports/sources',
      icon: Megaphone,
      title: 'Lead sources',
      description: 'Volume and conversion by lead source and campaign, so spend follows results.',
      stat: `${number(leads)} leads tracked`,
      urgent: false,
    },
  ]

  return (
    <>
      <PageHeader
        title="Reports"
        description={`Everything is scoped to the ${LEVEL_LABEL[level]} you can see`}
      />

      <div className="grid gap-4 p-4 sm:p-6 md:grid-cols-2 xl:grid-cols-3">
        {REPORTS.map((report) => (
          <Link
            key={report.href}
            href={report.href}
            className="group bg-card hover:border-primary/40 shadow-e1 hover:shadow-e2 flex flex-col rounded-xl border p-5 transition-all"
          >
            <div className="flex items-center gap-2.5">
              <span
                className={
                  report.urgent
                    ? 'bg-danger/10 text-danger flex size-8 items-center justify-center rounded-lg'
                    : 'bg-primary/10 text-primary flex size-8 items-center justify-center rounded-lg'
                }
              >
                <report.icon className="size-4" />
              </span>
              <h2 className="font-semibold">{report.title}</h2>
              <ArrowRight className="text-muted-foreground ml-auto size-4 transition-transform group-hover:translate-x-0.5" />
            </div>
            <p className="text-muted-foreground mt-2.5 flex-1 text-sm">{report.description}</p>
            <p
              className={
                report.urgent
                  ? 'text-danger mt-3 text-sm font-medium tabular-nums'
                  : 'mt-3 text-sm font-medium tabular-nums'
              }
            >
              {report.stat}
            </p>
          </Link>
        ))}
      </div>
    </>
  )
}
