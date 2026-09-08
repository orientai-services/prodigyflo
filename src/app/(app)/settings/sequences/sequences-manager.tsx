'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowDown,
  ArrowUp,
  Clock,
  Loader2,
  Mail,
  MessageSquareText,
  Pencil,
  Plus,
  Trash2,
  Users,
  Workflow,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { NativeSelect } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/empty-state'
import { deleteSequenceAction, saveSequenceAction } from './actions'

type Channel = 'EMAIL' | 'SMS'

export type StepDraft = {
  delayHours: number
  channel: Channel
  templateKey: string
  stopIfReplied: boolean
}

export type SequenceRow = {
  id: string
  name: string
  description: string | null
  isActive: boolean
  triggerStageKey: string | null
  steps: StepDraft[]
  totalEnrollments: number
  activeEnrollments: number
}

export type TemplateOption = { key: string; name: string; channel: Channel }
export type StageOption = { key: string; name: string }

function delayLabel(hours: number): string {
  if (hours === 0) return 'immediately'
  if (hours % 24 === 0) return `after ${hours / 24} day${hours === 24 ? '' : 's'}`
  return `after ${hours} hour${hours === 1 ? '' : 's'}`
}

function totalSpanLabel(steps: StepDraft[]): string {
  const total = steps.reduce((sum, s) => sum + s.delayHours, 0)
  if (total === 0) return 'all at once on the next run'
  if (total < 24) return `spans ~${total}h`
  return `spans ~${Math.round(total / 24)} day${Math.round(total / 24) === 1 ? '' : 's'}`
}

const EMPTY_DRAFT: { id?: string; name: string; description: string; isActive: boolean; triggerStageKey: string; steps: StepDraft[] } = {
  name: '',
  description: '',
  isActive: true,
  triggerStageKey: '',
  steps: [],
}

export function SequencesManager({
  canManage,
  sequences,
  templates,
  stages,
}: {
  canManage: boolean
  sequences: SequenceRow[]
  templates: TemplateOption[]
  stages: StageOption[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const stageName = (key: string | null) => stages.find((s) => s.key === key)?.name ?? key
  const templateName = (key: string, channel: Channel) =>
    templates.find((t) => t.key === key && t.channel === channel)?.name ?? key

  const templatesFor = useMemo(
    () => ({
      EMAIL: templates.filter((t) => t.channel === 'EMAIL'),
      SMS: templates.filter((t) => t.channel === 'SMS'),
    }),
    [templates],
  )

  const openCreate = () => {
    const firstEmail = templatesFor.EMAIL[0]?.key ?? templatesFor.SMS[0]?.key ?? ''
    setDraft({
      ...EMPTY_DRAFT,
      steps: firstEmail
        ? [{ delayHours: 24, channel: templatesFor.EMAIL.length > 0 ? 'EMAIL' : 'SMS', templateKey: firstEmail, stopIfReplied: true }]
        : [],
    })
    setOpen(true)
  }

  const openEdit = (s: SequenceRow) => {
    setDraft({
      id: s.id,
      name: s.name,
      description: s.description ?? '',
      isActive: s.isActive,
      triggerStageKey: s.triggerStageKey ?? '',
      steps: s.steps.map((st) => ({ ...st })),
    })
    setOpen(true)
  }

  const setStep = (index: number, patch: Partial<StepDraft>) => {
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((s, i) => {
        if (i !== index) return s
        const next = { ...s, ...patch }
        // Switching channel invalidates the template pick — snap to the first
        // template of the new channel so the row never points at a mismatch.
        if (patch.channel && patch.channel !== s.channel) {
          next.templateKey = templatesFor[patch.channel][0]?.key ?? ''
        }
        return next
      }),
    }))
  }

  const moveStep = (index: number, dir: -1 | 1) => {
    setDraft((d) => {
      const steps = [...d.steps]
      const target = index + dir
      if (target < 0 || target >= steps.length) return d
      ;[steps[index], steps[target]] = [steps[target], steps[index]]
      return { ...d, steps }
    })
  }

  const addStep = () => {
    const channel: Channel = templatesFor.EMAIL.length > 0 ? 'EMAIL' : 'SMS'
    const templateKey = templatesFor[channel][0]?.key ?? ''
    setDraft((d) => ({ ...d, steps: [...d.steps, { delayHours: 48, channel, templateKey, stopIfReplied: true }] }))
  }

  const save = () => {
    startTransition(async () => {
      const result = await saveSequenceAction({
        id: draft.id,
        name: draft.name,
        description: draft.description || undefined,
        isActive: draft.isActive,
        triggerStageKey: draft.triggerStageKey || null,
        steps: draft.steps,
      })
      if (result.ok) {
        toast.success(result.message ?? 'Saved.')
        setOpen(false)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const remove = async (id: string) => {
    setDeletingId(id)
    const result = await deleteSequenceAction(id)
    setDeletingId(null)
    setConfirmDeleteId(null)
    if (result.ok) {
      toast.success(result.message ?? 'Deleted.')
      router.refresh()
    } else {
      toast.error(result.error)
    }
  }

  const saveDisabled =
    pending ||
    !draft.name.trim() ||
    draft.steps.length === 0 ||
    draft.steps.some((s) => !s.templateKey)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          {sequences.length === 0
            ? 'No sequences yet.'
            : `${sequences.length} sequence${sequences.length === 1 ? '' : 's'} · ${sequences.filter((s) => s.isActive).length} active`}
        </p>
        {canManage && (
          <Button size="sm" onClick={openCreate} disabled={templates.length === 0}>
            <Plus className="size-3.5" />
            New sequence
          </Button>
        )}
      </div>

      {templates.length === 0 && (
        <p className="text-muted-foreground rounded-md border border-dashed p-3 text-sm">
          Sequences send from message templates — create a template under Settings → Message templates first.
        </p>
      )}

      {sequences.length === 0 ? (
        <EmptyState
          icon="Workflow"
          title="No sequences yet"
          description={
            canManage
              ? 'A sequence sends a series of templated messages on a schedule — for example a three-touch follow-up after a new lead comes in — and stops automatically when the client replies.'
              : 'Sequences configured for your organization will appear here.'
          }
          action={
            canManage && templates.length > 0 ? (
              <Button size="sm" onClick={openCreate}>
                <Plus className="size-3.5" />
                Create your first sequence
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {sequences.map((s) => (
            <div key={s.id} className="bg-surface-raised shadow-e1 flex flex-col rounded-lg border p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <Workflow className="text-muted-foreground size-4" />
                    <span className="truncate">{s.name}</span>
                    <Badge
                      variant={s.isActive ? 'default' : 'secondary'}
                      className="text-[10px] tracking-wide uppercase"
                    >
                      {s.isActive ? 'Active' : 'Paused'}
                    </Badge>
                  </p>
                  {s.description && <p className="text-muted-foreground mt-0.5 text-sm">{s.description}</p>}
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => openEdit(s)} title="Edit sequence">
                      <Pencil className="size-3.5" />
                    </Button>
                    {confirmDeleteId === s.id ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-7 px-2"
                        disabled={deletingId !== null}
                        onClick={() => remove(s.id)}
                        title="Click again to permanently delete"
                      >
                        {deletingId === s.id ? <Loader2 className="size-3.5 animate-spin" /> : 'Confirm delete'}
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive h-7 px-2"
                        onClick={() => setConfirmDeleteId(s.id)}
                        title="Delete sequence"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </div>
                )}
              </div>

              <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="flex items-center gap-1">
                  <Zap className="size-3" />
                  {s.triggerStageKey ? `Auto-enrolls on stage: ${stageName(s.triggerStageKey)}` : 'Manual enrollment only'}
                </span>
                <span className="flex items-center gap-1">
                  <Users className="size-3" />
                  {s.activeEnrollments} active / {s.totalEnrollments} total enrolled
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="size-3" />
                  {totalSpanLabel(s.steps)}
                </span>
              </div>

              <ol className="mt-3 space-y-1.5 border-l pl-3">
                {s.steps.map((st, i) => (
                  <li key={i} className="text-sm">
                    <span className="text-muted-foreground text-xs">
                      {i + 1}. {delayLabel(st.delayHours)} —{' '}
                    </span>
                    <span className="inline-flex items-center gap-1 font-medium">
                      {st.channel === 'EMAIL' ? <Mail className="size-3" /> : <MessageSquareText className="size-3" />}
                      {templateName(st.templateKey, st.channel)}
                    </span>
                    {st.stopIfReplied && (
                      <span className="text-muted-foreground text-xs"> · skipped if the client replied</span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={(v) => !pending && setOpen(v)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{draft.id ? 'Edit sequence' : 'New sequence'}</DialogTitle>
            <DialogDescription>
              Each step waits its delay, then sends the chosen template. Consent is re-checked at every send, and a
              step marked “stop if replied” ends the sequence when the client has written back.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="seq-name">Name</label>
                <Input
                  id="seq-name"
                  placeholder="e.g. New-lead follow-up"
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="seq-trigger">Auto-enroll on stage</label>
                <NativeSelect
                  id="seq-trigger"
                  value={draft.triggerStageKey}
                  onChange={(e) => setDraft((d) => ({ ...d, triggerStageKey: e.target.value }))}
                >
                  <option value="">Manual enrollment only</option>
                  {stages.map((st) => (
                    <option key={st.key} value={st.key}>
                      {st.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="seq-desc">Description</label>
              <Textarea
                id="seq-desc"
                rows={2}
                placeholder="What this sequence is for (shown to teammates)."
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={draft.isActive}
                onCheckedChange={(v) => setDraft((d) => ({ ...d, isActive: Boolean(v) }))}
              />
              <span className="font-medium">{draft.isActive ? 'Active' : 'Paused'}</span>
              <span className="text-muted-foreground text-xs">
                {draft.isActive ? '— enrollments run on schedule' : '— nothing sends while paused'}
              </span>
            </label>

            <div className="space-y-2">
              <p className="text-sm font-medium">Steps</p>
              {draft.steps.length === 0 && (
                <p className="text-muted-foreground rounded-md border border-dashed p-3 text-sm">
                  No steps yet — add the first message below.
                </p>
              )}
              {draft.steps.map((st, i) => (
                <div key={i} className="space-y-2 rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
                      {i + 1}
                    </span>
                    <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
                      Wait
                      <Input
                        type="number"
                        min={0}
                        max={2160}
                        value={st.delayHours}
                        onChange={(e) => setStep(i, { delayHours: Math.max(0, Number(e.target.value) || 0) })}
                        className="h-8 w-20"
                        aria-label={`Step ${i + 1} delay in hours`}
                      />
                      hours, then send
                    </label>
                    <NativeSelect
                      size="sm"
                      aria-label={`Step ${i + 1} channel`}
                      value={st.channel}
                      onChange={(e) => setStep(i, { channel: e.target.value as Channel })}
                    >
                      <option value="EMAIL" disabled={templatesFor.EMAIL.length === 0}>Email</option>
                      <option value="SMS" disabled={templatesFor.SMS.length === 0}>SMS</option>
                    </NativeSelect>
                    <NativeSelect
                      size="sm"
                      className="min-w-44 flex-1"
                      aria-label={`Step ${i + 1} template`}
                      value={st.templateKey}
                      onChange={(e) => setStep(i, { templateKey: e.target.value })}
                    >
                      {templatesFor[st.channel].map((t) => (
                        <option key={t.key} value={t.key}>
                          {t.name}
                        </option>
                      ))}
                    </NativeSelect>
                    <div className="ml-auto flex items-center gap-0.5">
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={i === 0} onClick={() => moveStep(i, -1)} title="Move up">
                        <ArrowUp className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={i === draft.steps.length - 1} onClick={() => moveStep(i, 1)} title="Move down">
                        <ArrowDown className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive h-7 w-7 p-0"
                        onClick={() => setDraft((d) => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }))}
                        title="Remove step"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                  <label className="text-muted-foreground flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={st.stopIfReplied}
                      onChange={(e) => setStep(i, { stopIfReplied: e.target.checked })}
                      className="accent-primary size-3.5"
                    />
                    Skip this step and end the sequence if the client has replied
                  </label>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addStep} disabled={templates.length === 0}>
                <Plus className="size-3.5" />
                Add step
              </Button>
              {draft.steps.length > 0 && (
                <p className="text-muted-foreground text-xs">
                  Cadence preview: {draft.steps.map((s, i) => `${i + 1}) ${delayLabel(s.delayHours)}`).join(' → ')} —{' '}
                  {totalSpanLabel(draft.steps)}.
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saveDisabled}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              {draft.id ? 'Save changes' : 'Create sequence'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
