import { redirect } from 'next/navigation'
import {
  ArrowDownLeft,
  ArrowUpRight,
  FlaskConical,
  Mail,
  MessageSquareText,
  Phone,
  StickyNote,
} from 'lucide-react'
import type { CommunicationChannel, CommunicationStatus } from '@prisma/client'
import { db } from '@/lib/db'
import { can, canSeeInternal, findClientInScope, requireUser } from '@/lib/rbac'
import { dateTime, relativeTime, shortDate } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/empty-state'
import { getConsentDecision } from '@/lib/messaging/consent'
import { isMockMode } from '@/lib/messaging'
import { baseVarsForClient, pickTemplate } from '@/lib/messaging/render'
import {
  Composer,
  ReminderSendButtons,
  type ComposerTemplate,
  type ConsentInfo,
  type ReminderItem,
} from '@/lib/messaging/ui/composer'
import {
  ScheduledMessagesStrip,
  SequenceEnrollmentPanel,
  type EnrollmentInfo,
  type ScheduledItem,
  type SequenceOption,
} from '@/lib/automation/ui'

const CHANNEL_ICON: Partial<Record<CommunicationChannel, typeof Mail>> = {
  EMAIL: Mail,
  SMS: MessageSquareText,
  IMESSAGE: MessageSquareText,
  CALL: Phone,
  NOTE: StickyNote,
}

const STATUS_STYLE: Record<CommunicationStatus, string> = {
  QUEUED: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  SENT: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  DELIVERED: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  READ: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  FAILED: 'bg-destructive/15 text-destructive',
  RECEIVED: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
}

function channelLabel(channel: CommunicationChannel): string {
  if (channel === 'EMAIL') return 'Email'
  if (channel === 'SMS') return 'SMS'
  if (channel === 'IMESSAGE') return 'iMessage'
  return channel.toLowerCase().replace(/_/g, ' ')
}

export async function CommunicationsTab({ clientId }: { clientId: string }) {
  const user = await requireUser()

  if (!can(user, 'communications:read')) {
    return (
      <EmptyState
        icon="Lock"
        title="No access to communications"
        description="Your role does not include permission to view the communication timeline."
      />
    )
  }

  const client = await findClientInScope(user, clientId, {
    owner: { select: { name: true } },
    organization: { select: { name: true } },
  })
  if (!client) redirect('/forbidden')

  const now = new Date()
  const [
    communications,
    templates,
    emailConsent,
    smsConsent,
    appointments,
    outstandingDocs,
    scheduledMessages,
    sequences,
    enrollments,
  ] = await Promise.all([
    db.communication.findMany({
      where: { clientId: client.id },
      orderBy: { occurredAt: 'desc' },
      take: 100,
      include: {
        user: { select: { name: true } },
        message: { select: { failureCode: true, toMasked: true, fromMasked: true, optOutDetected: true } },
        call: { select: { outcome: true, durationSeconds: true } },
      },
    }),
    db.messageTemplate.findMany({
      where: { organizationId: user.organizationId, isActive: true, channel: { in: ['EMAIL', 'SMS'] } },
      orderBy: [{ name: 'asc' }, { locale: 'asc' }],
    }),
    getConsentDecision(client.id, 'EMAIL'),
    getConsentDecision(client.id, 'SMS'),
    db.appointment.findMany({
      where: { clientId: client.id, status: { in: ['SCHEDULED', 'CONFIRMED'] }, startsAt: { gt: now } },
      orderBy: { startsAt: 'asc' },
      take: 3,
      select: { id: true, type: true, startsAt: true, timezone: true, location: true },
    }),
    db.clientDocument.findMany({
      where: { clientId: client.id, status: { in: ['REQUESTED', 'MISSING_INFORMATION'] } },
      orderBy: { requestedAt: 'asc' },
      take: 5,
      select: {
        id: true,
        status: true,
        label: true,
        fileName: true,
        requestedAt: true,
        requirement: { select: { name: true } },
      },
    }),
    db.scheduledMessage.findMany({
      where: { clientId: client.id, status: 'PENDING' },
      orderBy: { sendAt: 'asc' },
      take: 20,
    }),
    db.sequence.findMany({
      where: { organizationId: user.organizationId, isActive: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { steps: true } } },
    }),
    db.sequenceEnrollment.findMany({
      where: { clientId: client.id },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      include: { sequence: { select: { name: true, _count: { select: { steps: true } } } } },
    }),
  ])

  const locale = client.preferredLanguage || 'en'
  const templateFor = (key: string): string | null =>
    pickTemplate(templates.filter((t) => t.key === key), locale)?.id ?? null
  const templateNameFor = (key: string | null): string | null =>
    key ? (templates.find((t) => t.key === key)?.name ?? key) : null

  const consent: Record<'EMAIL' | 'SMS', ConsentInfo> = {
    EMAIL: emailConsent.allowed ? { allowed: true } : { allowed: false, reason: emailConsent.reason },
    SMS: smsConsent.allowed ? { allowed: true } : { allowed: false, reason: smsConsent.reason },
  }

  // The composer previews with the client's locale templates (English fallback),
  // deduplicated per key so the picker shows one entry per template.
  const pickerTemplates: ComposerTemplate[] = [...new Set(templates.map((t) => t.key))]
    .map((key) => pickTemplate(templates.filter((t) => t.key === key), locale))
    .filter((t): t is (typeof templates)[number] => t !== null)
    .map((t) => ({
      id: t.id,
      key: t.key,
      name: t.name,
      channel: t.channel as 'EMAIL' | 'SMS',
      locale: t.locale,
      subject: t.subject,
      body: t.body,
    }))

  const reminders: ReminderItem[] = [
    ...appointments.map((a) => ({
      key: `appt-${a.id}`,
      kind: 'appointment' as const,
      label: `${a.type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())} appointment`,
      sublabel: `${dateTime(a.startsAt, a.timezone)}${a.location ? ` · ${a.location}` : ''}`,
      context: { appointmentId: a.id },
      emailTemplateId: templateFor('appointment_reminder_email'),
      smsTemplateId: templateFor('appointment_reminder_sms'),
    })),
    ...outstandingDocs.map((d) => {
      const missing = d.status === 'MISSING_INFORMATION'
      return {
        key: `doc-${d.id}`,
        kind: 'document' as const,
        label: d.requirement?.name ?? d.label ?? d.fileName ?? 'Requested document',
        sublabel: missing
          ? 'Missing information — needs a corrected copy'
          : `Requested ${relativeTime(d.requestedAt)}`,
        context: { documentId: d.id },
        emailTemplateId: templateFor(missing ? 'missing_info_email' : 'document_request_email'),
        smsTemplateId: templateFor(missing ? 'missing_info_sms' : 'document_request_sms'),
      }
    }),
  ]

  const scheduledItems: ScheduledItem[] = scheduledMessages.map((sm) => ({
    id: sm.id,
    channel: sm.channel as 'EMAIL' | 'SMS',
    templateName: templateNameFor(sm.templateKey),
    subject: sm.subject,
    body: sm.body,
    sendAt: dateTime(sm.sendAt),
    attempts: sm.attempts,
    error: sm.error,
  }))

  const sequenceOptions: SequenceOption[] = sequences
    .filter((s) => s._count.steps > 0)
    .map((s) => ({ id: s.id, name: s.name, stepCount: s._count.steps }))

  const enrollmentInfos: EnrollmentInfo[] = enrollments.map((e) => {
    const total = e.sequence._count.steps
    const stepNo = Math.min(e.currentStep + 1, total)
    const label =
      e.status === 'ACTIVE'
        ? `step ${stepNo} of ${total}${e.nextRunAt ? ` · next ${dateTime(e.nextRunAt)}` : ''}`
        : `${Math.min(e.currentStep, total)} of ${total} steps sent`
    return {
      id: e.id,
      sequenceName: e.sequence.name,
      status: e.status,
      stepLabel: label,
      stoppedReason: e.status === 'ACTIVE' ? null : e.stoppedReason,
    }
  })

  const mockEmail = isMockMode('EMAIL')
  const mockSms = isMockMode('SMS')
  const showInternal = canSeeInternal(user)
  const visible = communications.filter((c) => !c.isInternal || showInternal)
  const vars = baseVarsForClient(client as never)
  const canSend = can(user, 'communications:send')

  // Conversation order: oldest first, grouped by calendar day.
  const thread = [...visible].reverse()
  const days: { day: string; items: typeof thread }[] = []
  for (const c of thread) {
    const day = shortDate(c.occurredAt)
    const bucket = days[days.length - 1]
    if (bucket && bucket.day === day) bucket.items.push(c)
    else days.push({ day, items: [c] })
  }

  return (
    <div className="space-y-4">
      {(mockEmail || mockSms) && (
        <div className="flex items-start gap-2.5 rounded-lg border border-dashed border-amber-500/60 bg-amber-500/10 p-3 text-sm">
          <FlaskConical className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <p className="font-medium">
              Mock messaging mode
              <Badge variant="outline" className="ml-2 border-amber-500/60 text-[10px] tracking-wide uppercase">
                {[mockEmail && 'email', mockSms && 'sms'].filter(Boolean).join(' + ')}
              </Badge>
            </p>
            <p className="text-muted-foreground text-xs">
              No real email or SMS leaves this system. Sends below are simulated and recorded for review only.
            </p>
          </div>
        </div>
      )}

      <SequenceEnrollmentPanel
        clientId={client.id}
        sequences={sequenceOptions}
        enrollments={enrollmentInfos}
        canSend={canSend}
      />

      <ScheduledMessagesStrip items={canSend ? scheduledItems : []} />

      {days.length === 0 ? (
        <EmptyState
          icon="MessagesSquare"
          title="No conversation yet"
          description="Messages sent to this client, and anything they send back, will appear here as a conversation."
        />
      ) : (
        <div className="space-y-4">
          {days.map(({ day, items }) => (
            <div key={day} className="space-y-2.5">
              <div className="flex items-center gap-3">
                <div className="bg-border h-px flex-1" />
                <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">{day}</span>
                <div className="bg-border h-px flex-1" />
              </div>
              {items.map((c) => {
                const Icon = CHANNEL_ICON[c.channel] ?? StickyNote
                const outbound = c.direction === 'OUTBOUND'
                const conversational = c.channel === 'EMAIL' || c.channel === 'SMS' || c.channel === 'IMESSAGE' || c.channel === 'PORTAL_MESSAGE' || c.channel === 'MESSENGER'

                if (!conversational) {
                  // Calls, notes, and in-person touches sit centred between the bubbles.
                  return (
                    <div key={c.id} className="flex justify-center">
                      <div className="bg-surface-sunk/60 text-muted-foreground flex max-w-[85%] flex-wrap items-center gap-x-2 gap-y-1 rounded-full border px-3 py-1.5 text-xs">
                        <Icon className="size-3.5" />
                        <span className="font-medium">{channelLabel(c.channel)}</span>
                        {c.call && (
                          <span>
                            {c.call.outcome.toLowerCase().replace(/_/g, ' ')}
                            {c.call.durationSeconds > 0 && ` · ${Math.round(c.call.durationSeconds / 60)}m`}
                          </span>
                        )}
                        {c.isInternal && (
                          <Badge variant="secondary" className="text-[10px]">
                            Internal
                          </Badge>
                        )}
                        {c.body && <span className="max-w-96 truncate">{c.body}</span>}
                        <span title={dateTime(c.occurredAt)}>{relativeTime(c.occurredAt)}</span>
                      </div>
                    </div>
                  )
                }

                return (
                  <div key={c.id} className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] sm:max-w-[70%] ${outbound ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
                      <div
                        className={`rounded-2xl border px-3.5 py-2.5 shadow-e1 ${
                          outbound
                            ? 'bg-primary/10 border-primary/20 rounded-br-sm'
                            : 'bg-surface-raised rounded-bl-sm'
                        }`}
                      >
                        {c.subject && <p className="mb-0.5 text-sm font-semibold">{c.subject}</p>}
                        {c.body && <p className="text-sm whitespace-pre-wrap">{c.body}</p>}
                        {c.status === 'FAILED' && c.message?.failureCode && (
                          <p className="text-destructive mt-1 text-xs">Failure: {c.message.failureCode}</p>
                        )}
                        {c.message?.optOutDetected && (
                          <p className="text-destructive mt-1 text-xs font-medium">Opt-out detected in this message</p>
                        )}
                      </div>
                      <div
                        className={`text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1 text-[11px] ${
                          outbound ? 'flex-row-reverse' : ''
                        }`}
                      >
                        <span className="flex items-center gap-1 font-medium">
                          {outbound ? <ArrowUpRight className="size-3" /> : <ArrowDownLeft className="size-3" />}
                          {channelLabel(c.channel)}
                        </span>
                        <span
                          className={`rounded-full px-1.5 py-px text-[10px] font-medium tracking-wide uppercase ${STATUS_STYLE[c.status]}`}
                        >
                          {c.status.toLowerCase()}
                        </span>
                        {c.templateKey && (
                          <Badge variant="outline" className="text-[10px]">
                            {c.templateKey}
                          </Badge>
                        )}
                        {c.externalRef?.startsWith('mock-') && (
                          <Badge variant="outline" className="border-amber-500/60 text-[10px] uppercase">
                            mock
                          </Badge>
                        )}
                        {c.isInternal && (
                          <Badge variant="secondary" className="text-[10px]">
                            Internal
                          </Badge>
                        )}
                        <span>
                          {outbound
                            ? `${c.user?.name ?? 'Automation'}${c.message?.toMasked ? ` → ${c.message.toMasked}` : ''}`
                            : `${client.firstName}${c.message?.fromMasked ? ` (${c.message.fromMasked})` : ''}`}
                        </span>
                        <span title={dateTime(c.occurredAt)}>· {relativeTime(c.occurredAt)}</span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {canSend && reminders.length > 0 && (
        <div>
          <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
            One-click reminders
          </h3>
          <ReminderSendButtons clientId={client.id} items={reminders} consent={consent} />
        </div>
      )}

      <Composer
        clientId={client.id}
        templates={pickerTemplates}
        consent={consent}
        vars={vars}
        canSend={canSend}
      />
    </div>
  )
}
