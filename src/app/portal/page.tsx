import { CalendarDays, Check, FileText, MapPin, MessagesSquare, Sparkles, Video } from 'lucide-react'
import { cn } from '@/lib/utils'
import { dateTime, relativeTime } from '@/lib/format'
import {
  clientStageView,
  loadPortalAppointments,
  loadPortalDocuments,
  loadPortalMessages,
  PORTAL_COPY,
  PORTAL_STEPS,
  requirePortalClient,
  DOC_STATUS_VIEWS,
  type DocTone,
} from '@/lib/portal'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/empty-state'
import { loadPortalNurtureTouches, PORTAL_NURTURE_KIND_LABEL } from '@/lib/nurture'
import { PortalUpload } from './portal-upload'
import { NurtureTouchRow } from './nurture-touch'
import { MessageForm } from './message-form'

const TONE_STYLES: Record<DocTone, { badge: string; dot: string }> = {
  needed: { badge: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300', dot: 'bg-amber-500' },
  received: { badge: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300', dot: 'bg-blue-500' },
  reviewing: { badge: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300', dot: 'bg-violet-500' },
  approved: { badge: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300', dot: 'bg-emerald-500' },
  action: { badge: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300', dot: 'bg-rose-500' },
}

export default async function PortalPage() {
  const { client } = await requirePortalClient()
  const stage = clientStageView(client.currentStage.key)

  const [documents, messages, appointments, nurtureTouches] = await Promise.all([
    loadPortalDocuments(client.id),
    loadPortalMessages(client.id, client.organization.name),
    loadPortalAppointments(client.id),
    loadPortalNurtureTouches(client.id),
  ])

  return (
    <div className="flex flex-col gap-6">
      {/* ── Greeting + progress ─────────────────────────────── */}
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">
          Hi, {client.firstName}
        </h1>
        {client.owner && (
          <p className="text-muted-foreground mt-1 text-sm">
            {PORTAL_COPY.advisorLabel}: <span className="text-foreground font-medium">{client.owner.name}</span>
          </p>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>{stage.step === null ? stage.headline : PORTAL_COPY.progressTitle}</CardTitle>
          <CardDescription>{stage.detail}</CardDescription>
        </CardHeader>
        {stage.step !== null && (
          <CardContent>
            <div className="mb-3">
              <p className="text-sm font-medium">{stage.headline}</p>
            </div>
            <ol className="flex items-start" aria-label="Progress">
              {PORTAL_STEPS.map((s, i) => {
                const state = i < (stage.step as number) ? 'done' : i === stage.step ? 'current' : 'upcoming'
                return (
                  <li key={s.key} className="flex flex-1 flex-col items-center gap-1.5">
                    <div className="flex w-full items-center">
                      <div
                        className={cn(
                          'h-0.5 flex-1 rounded-full',
                          i === 0 ? 'opacity-0' : state === 'upcoming' ? 'bg-border' : 'bg-brand',
                        )}
                      />
                      <div
                        className={cn(
                          'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors',
                          state === 'done' && 'border-brand bg-brand text-primary-foreground',
                          state === 'current' && 'border-brand bg-brand-soft text-brand ring-brand/25 ring-4',
                          state === 'upcoming' && 'border-border bg-background text-muted-foreground',
                        )}
                        aria-current={state === 'current' ? 'step' : undefined}
                      >
                        {state === 'done' ? <Check className="size-3.5" /> : i + 1}
                      </div>
                      <div
                        className={cn(
                          'h-0.5 flex-1 rounded-full',
                          i === PORTAL_STEPS.length - 1 ? 'opacity-0' : state === 'done' ? 'bg-brand' : 'bg-border',
                        )}
                      />
                    </div>
                    <span
                      className={cn(
                        'px-0.5 text-center text-[0.625rem] leading-tight font-medium sm:text-xs',
                        state === 'current' ? 'text-brand' : state === 'done' ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {s.label}
                    </span>
                  </li>
                )
              })}
            </ol>
          </CardContent>
        )}
      </Card>

      {/* ── From your advisor ───────────────────────────────── */}
      {nurtureTouches.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="text-muted-foreground size-4" />
              From your advisor
            </CardTitle>
            <CardDescription>Made for you by your advisor — take a look when you have a minute.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {nurtureTouches.map((t) => (
                <NurtureTouchRow
                  key={t.id}
                  touchId={t.id}
                  kind={t.kind}
                  kindLabel={PORTAL_NURTURE_KIND_LABEL[t.kind]}
                  url={t.url}
                  note={t.note}
                  sentLabel={relativeTime(t.sentAt)}
                  senderFirstName={t.senderFirstName}
                  confirmed={t.confirmedAt !== null}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* ── Documents ───────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="text-muted-foreground size-4" />
            {PORTAL_COPY.documentsTitle}
          </CardTitle>
          <CardDescription>{PORTAL_COPY.documentsSubtitle}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {documents.length === 0 ? (
            <EmptyState
              icon="FileCheck"
              title={PORTAL_COPY.documentsEmptyTitle}
              description={PORTAL_COPY.documentsEmptyBody}
              className="py-10"
            />
          ) : (
            <ul className="divide-y">
              {documents.map((doc) => {
                const view = DOC_STATUS_VIEWS[doc.status]
                const tone = TONE_STYLES[view.tone]
                return (
                  <li key={doc.requirementId} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium">{doc.name}</p>
                        <span
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
                            tone.badge,
                          )}
                        >
                          <span className={cn('size-1.5 rounded-full', tone.dot)} aria-hidden />
                          {view.label}
                        </span>
                      </div>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {view.tone === 'action' && doc.clientVisibleComment ? doc.clientVisibleComment : view.hint}
                      </p>
                    </div>
                    {doc.canUpload && (
                      <PortalUpload
                        requirementId={doc.requirementId}
                        buttonLabel={doc.status === 'REQUESTED' ? PORTAL_COPY.uploadCta : PORTAL_COPY.uploadReplaceCta}
                        busyLabel={PORTAL_COPY.uploadBusy}
                        successMessage={PORTAL_COPY.uploadSuccess}
                        failureMessage={PORTAL_COPY.uploadFailed}
                        emphasized={view.tone === 'needed' || view.tone === 'action'}
                      />
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── Appointments ────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarDays className="text-muted-foreground size-4" />
            {PORTAL_COPY.appointmentsTitle}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {appointments.length === 0 ? (
            <EmptyState
              icon="CalendarClock"
              title={PORTAL_COPY.appointmentsEmptyTitle}
              description={PORTAL_COPY.appointmentsEmptyBody}
              className="py-10"
            />
          ) : (
            <ul className="divide-y">
              {appointments.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{a.typeLabel}</p>
                      {a.isConfirmed && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                          <Check className="size-3" /> Confirmed
                        </span>
                      )}
                    </div>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {dateTime(a.startsAt, a.timezone)} · with {a.withName}
                    </p>
                    {a.location && (
                      <p className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
                        <MapPin className="size-3" /> {a.location}
                      </p>
                    )}
                  </div>
                  {a.meetingUrl && (
                    <a
                      href={a.meetingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
                    >
                      <Video className="size-4" /> Join
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── Messages ────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessagesSquare className="text-muted-foreground size-4" />
            {PORTAL_COPY.messagesTitle}
          </CardTitle>
          <CardDescription>{PORTAL_COPY.messagesSubtitle}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {messages.length === 0 ? (
            <EmptyState
              icon="MessageCircle"
              title={PORTAL_COPY.messagesEmptyTitle}
              description={PORTAL_COPY.messagesEmptyBody}
              className="py-8"
            />
          ) : (
            <ul className="flex max-h-96 flex-col gap-3 overflow-y-auto pr-1">
              {messages.map((m) => (
                <li
                  key={m.id}
                  className={cn('flex flex-col', m.direction === 'INBOUND' ? 'items-end' : 'items-start')}
                >
                  <div
                    className={cn(
                      'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm whitespace-pre-wrap',
                      m.direction === 'INBOUND'
                        ? 'bg-brand text-primary-foreground rounded-br-md'
                        : 'bg-surface-sunk rounded-bl-md',
                    )}
                  >
                    {m.subject && m.subject !== 'Portal message' && (
                      <p className={cn('mb-0.5 text-xs font-semibold', m.direction !== 'INBOUND' && 'text-foreground')}>
                        {m.subject}
                      </p>
                    )}
                    {m.body ?? m.subject ?? ''}
                  </div>
                  <span className="text-muted-foreground mt-1 px-1 text-[0.6875rem]">
                    {m.senderName} · {relativeTime(m.occurredAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t pt-4">
            <MessageForm
              placeholder={PORTAL_COPY.messagePlaceholder}
              sendLabel={PORTAL_COPY.messageSend}
              sendingLabel={PORTAL_COPY.messageSending}
              sentMessage={PORTAL_COPY.messageSent}
              emptyMessage={PORTAL_COPY.messageEmpty}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
