'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CalendarClock, FileWarning, Loader2, Mail, MessageSquareText, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { NativeSelect } from '@/components/ui/native-select'
import { renderTemplate, type TemplateVars } from '@/lib/messaging/render'
import { sendMessageAction } from '@/lib/messaging/actions'
import { scheduleMessageAction } from '@/lib/automation/actions'

export type ComposerTemplate = {
  id: string
  key: string
  name: string
  channel: 'EMAIL' | 'SMS'
  locale: string
  subject: string | null
  body: string
}

export type ConsentInfo = { allowed: boolean; reason?: string }

type Channel = 'EMAIL' | 'SMS'

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-md border px-2 text-sm outline-none focus-visible:ring-3 disabled:opacity-50'

function defaultDue(): string {
  const d = new Date(Date.now() + 3 * 86_400_000)
  return d.toISOString().slice(0, 10)
}

/** Tomorrow 9:00 local, formatted for a datetime-local input. */
function defaultSendAt(): string {
  const d = new Date(Date.now() + 86_400_000)
  d.setHours(9, 0, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function Composer({
  clientId,
  templates,
  consent,
  vars,
  canSend,
}: {
  clientId: string
  templates: ComposerTemplate[]
  consent: Record<Channel, ConsentInfo>
  vars: TemplateVars
  canSend: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [channel, setChannel] = useState<Channel>('EMAIL')
  const [templateId, setTemplateId] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [followUp, setFollowUp] = useState(false)
  const [dueAt, setDueAt] = useState(defaultDue)
  const [sendLater, setSendLater] = useState(false)
  const [sendAt, setSendAt] = useState(defaultSendAt)

  const channelTemplates = templates.filter((t) => t.channel === channel)
  const template = channelTemplates.find((t) => t.id === templateId) ?? null

  const source = template ?? { subject: channel === 'EMAIL' ? subject : null, body }
  const preview = source.body?.trim() ? renderTemplate({ subject: source.subject, body: source.body }, vars) : null

  const blocked = !consent[channel].allowed
  const empty = !template && !body.trim()
  const missingSubject = channel === 'EMAIL' && !template && !subject.trim()
  const scheduleMissing = sendLater && !sendAt
  const disabled =
    !canSend || pending || blocked || empty || missingSubject || scheduleMissing ||
    (preview?.unresolved.length ?? 0) > 0

  const reset = () => {
    setBody('')
    setSubject('')
    setTemplateId('')
    setFollowUp(false)
    setSendLater(false)
    setSendAt(defaultSendAt())
  }

  const send = () => {
    startTransition(async () => {
      if (sendLater) {
        if (new Date(sendAt).getTime() < Date.now() + 60_000) {
          toast.error('Pick a time at least a minute in the future — or just send now.')
          return
        }
        const result = await scheduleMessageAction({
          clientId,
          channel,
          ...(template ? { templateId: template.id } : { subject: subject || undefined, body }),
          sendAt: new Date(sendAt),
        })
        if (result.ok) {
          toast.success(result.message ?? 'Message scheduled.')
          reset()
          router.refresh()
        } else {
          toast.error(result.error)
        }
        return
      }

      const result = await sendMessageAction({
        clientId,
        channel,
        ...(template ? { templateId: template.id } : { subject: subject || undefined, body }),
        ...(followUp ? { followUpTask: { dueAt: new Date(`${dueAt}T09:00:00`) } } : {}),
      })
      if (result.ok) {
        if (result.status === 'SENT') {
          toast.success(`${channel === 'EMAIL' ? 'Email' : 'SMS'} sent${result.mock ? ' (mock)' : ''}`)
        } else {
          toast.error(`Send failed: ${result.error ?? 'provider error'}`)
        }
        reset()
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  if (!canSend) return null

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border p-0.5">
          {(['EMAIL', 'SMS'] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                setChannel(c)
                setTemplateId('')
              }}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                channel === c ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {c === 'EMAIL' ? <Mail className="size-3.5" /> : <MessageSquareText className="size-3.5" />}
              {c === 'EMAIL' ? 'Email' : 'SMS'}
            </button>
          ))}
        </div>
        <NativeSelect
          aria-label="Template"
          className={`${selectClass} max-w-64 flex-1`}
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
        >
          <option value="">Custom message…</option>
          {channelTemplates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.locale})
            </option>
          ))}
        </NativeSelect>
      </div>

      {blocked && (
        <div className="text-destructive bg-destructive/10 flex items-start gap-2 rounded-md p-2.5 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{consent[channel].reason ?? 'Consent is missing for this channel.'}</span>
        </div>
      )}

      {!template && (
        <div className="space-y-2">
          {channel === 'EMAIL' && (
            <Input
              placeholder="Subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={blocked}
            />
          )}
          <Textarea
            placeholder={`Write your ${channel === 'EMAIL' ? 'email' : 'text message'}… ({{first_name}} style variables are supported)`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            disabled={blocked}
          />
        </div>
      )}

      {preview && (
        <div className="bg-muted/40 space-y-1 rounded-md border p-3 text-sm">
          <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">Preview</p>
          {channel === 'EMAIL' && preview.subject && <p className="font-medium">{preview.subject}</p>}
          <p className="whitespace-pre-wrap">{preview.body}</p>
          {preview.unresolved.length > 0 && (
            <p className="text-destructive flex items-center gap-1.5 pt-1 text-xs">
              <FileWarning className="size-3.5" />
              Unresolved: {preview.unresolved.map((v) => `{{${v}}}`).join(', ')} — sending is blocked until every
              variable resolves.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {!sendLater && (
            <label className="text-muted-foreground flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={followUp}
                onChange={(e) => setFollowUp(e.target.checked)}
                className="accent-primary size-3.5"
              />
              Create follow-up task
              {followUp && (
                <input
                  type="date"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                  className="border-input bg-background h-7 rounded-md border px-1.5 text-xs"
                  aria-label="Follow-up due date"
                />
              )}
            </label>
          )}
          <label className="text-muted-foreground flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={sendLater}
              onChange={(e) => setSendLater(e.target.checked)}
              className="accent-primary size-3.5"
            />
            Send later
            {sendLater && (
              <input
                type="datetime-local"
                value={sendAt}
                onChange={(e) => setSendAt(e.target.value)}
                className="border-input bg-background h-7 rounded-md border px-1.5 text-xs"
                aria-label="Send date and time"
              />
            )}
          </label>
          {scheduleMissing && (
            <span className="text-destructive text-xs">Pick when this should go out.</span>
          )}
        </div>
        <Button size="sm" onClick={send} disabled={disabled}>
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : sendLater ? (
            <CalendarClock className="size-3.5" />
          ) : (
            <Send className="size-3.5" />
          )}
          {sendLater ? 'Schedule' : 'Send'} {channel === 'EMAIL' ? 'email' : 'SMS'}
        </Button>
      </div>
    </div>
  )
}

export type ReminderItem = {
  key: string
  kind: 'appointment' | 'document'
  label: string
  sublabel: string
  context: { appointmentId?: string; documentId?: string }
  emailTemplateId: string | null
  smsTemplateId: string | null
}

/** One-click reminder sends for upcoming appointments and outstanding documents. */
export function ReminderSendButtons({
  clientId,
  items,
  consent,
}: {
  clientId: string
  items: ReminderItem[]
  consent: Record<Channel, ConsentInfo>
}) {
  const router = useRouter()
  const [pendingKey, setPendingKey] = useState<string | null>(null)

  const send = async (item: ReminderItem, channel: Channel, templateId: string) => {
    setPendingKey(`${item.key}:${channel}`)
    const result = await sendMessageAction({ clientId, channel, templateId, context: item.context })
    setPendingKey(null)
    if (result.ok && result.status === 'SENT') {
      toast.success(`Reminder ${channel === 'EMAIL' ? 'email' : 'SMS'} sent${result.mock ? ' (mock)' : ''}`)
      router.refresh()
    } else {
      toast.error(result.ok ? `Send failed: ${result.error ?? 'provider error'}` : result.error)
      if (result.ok) router.refresh()
    }
  }

  if (items.length === 0) return null

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.key} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2.5">
          <div className="flex min-w-0 items-center gap-2">
            {item.kind === 'appointment' ? (
              <CalendarClock className="text-muted-foreground size-4 shrink-0" />
            ) : (
              <FileWarning className="text-muted-foreground size-4 shrink-0" />
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{item.label}</p>
              <p className="text-muted-foreground truncate text-xs">{item.sublabel}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {item.emailTemplateId && (
              <Button
                variant="outline"
                size="sm"
                disabled={!consent.EMAIL.allowed || pendingKey !== null}
                title={consent.EMAIL.allowed ? 'Send reminder email now' : consent.EMAIL.reason}
                onClick={() => send(item, 'EMAIL', item.emailTemplateId!)}
              >
                {pendingKey === `${item.key}:EMAIL` ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Mail className="size-3.5" />
                )}
                Email
              </Button>
            )}
            {item.smsTemplateId && (
              <Button
                variant="outline"
                size="sm"
                disabled={!consent.SMS.allowed || pendingKey !== null}
                title={consent.SMS.allowed ? 'Send reminder SMS now' : consent.SMS.reason}
                onClick={() => send(item, 'SMS', item.smsTemplateId!)}
              >
                {pendingKey === `${item.key}:SMS` ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <MessageSquareText className="size-3.5" />
                )}
                SMS
              </Button>
            )}
            {!item.emailTemplateId && !item.smsTemplateId && (
              <Badge variant="outline" className="text-xs">
                No reminder template
              </Badge>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
