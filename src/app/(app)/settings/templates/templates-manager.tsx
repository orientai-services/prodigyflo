'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, FlaskConical, Loader2, Mail, MessageSquareText, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { NativeSelect } from '@/components/ui/native-select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/empty-state'
import { KNOWN_VARIABLES } from '@/lib/messaging/render'
import { deleteTemplateAction, saveTemplateAction } from './actions'

type TemplateRow = {
  id: string
  key: string
  name: string
  channel: 'EMAIL' | 'SMS'
  locale: string
  subject: string | null
  body: string
  description: string | null
  isActive: boolean
  updatedAt: string
  createdByName: string | null
}

type ClientOption = { id: string; name: string; locale: string }

type FormState = {
  id?: string
  key: string
  name: string
  channel: 'EMAIL' | 'SMS'
  locale: string
  subject: string
  body: string
  description: string
  isActive: boolean
}

const EMPTY_FORM: FormState = {
  key: '',
  name: '',
  channel: 'EMAIL',
  locale: 'en',
  subject: '',
  body: '',
  description: '',
  isActive: true,
}

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-md border px-2 text-sm outline-none focus-visible:ring-3'

type Preview = { subject: string | null; body: string; unresolved: string[] } | null

export function TemplatesManager({
  templates,
  clients,
  mock,
}: {
  templates: TemplateRow[]
  clients: ClientOption[]
  mock: { EMAIL: boolean; SMS: boolean }
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [editorOpen, setEditorOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const [previewFor, setPreviewFor] = useState<TemplateRow | null>(null)
  const [previewClientId, setPreviewClientId] = useState(clients[0]?.id ?? '')
  // null = loading (fetch in flight), 'error' = fetch failed.
  const [preview, setPreview] = useState<Preview | 'error'>(null)

  useEffect(() => {
    if (!previewFor || !previewClientId) return
    let cancelled = false
    fetch(`/api/templates/preview?templateId=${previewFor.id}&clientId=${previewClientId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Preview failed')
        return r.json()
      })
      .then((data) => {
        if (!cancelled) setPreview(data)
      })
      .catch((err) => {
        if (!cancelled) {
          setPreview('error')
          toast.error(err instanceof Error ? err.message : 'Preview failed')
        }
      })
    return () => {
      cancelled = true
    }
  }, [previewFor, previewClientId])

  const openCreate = () => {
    setForm(EMPTY_FORM)
    setErrors({})
    setEditorOpen(true)
  }

  const openEdit = (t: TemplateRow) => {
    setForm({
      id: t.id,
      key: t.key,
      name: t.name,
      channel: t.channel,
      locale: t.locale,
      subject: t.subject ?? '',
      body: t.body,
      description: t.description ?? '',
      isActive: t.isActive,
    })
    setErrors({})
    setEditorOpen(true)
  }

  const save = () => {
    startTransition(async () => {
      const result = await saveTemplateAction({
        ...form,
        subject: form.subject || undefined,
        description: form.description || undefined,
      })
      if (result.ok) {
        toast.success(form.id ? 'Template updated' : 'Template created')
        setEditorOpen(false)
        router.refresh()
      } else {
        setErrors(result.errors)
        if (result.errors._form) toast.error(result.errors._form)
      }
    })
  }

  const toggleActive = (t: TemplateRow) => {
    startTransition(async () => {
      const result = await saveTemplateAction({
        id: t.id,
        key: t.key,
        name: t.name,
        channel: t.channel,
        locale: t.locale,
        subject: t.subject ?? undefined,
        body: t.body,
        description: t.description ?? undefined,
        isActive: !t.isActive,
      })
      if (result.ok) {
        toast.success(t.isActive ? 'Template deactivated' : 'Template activated')
        router.refresh()
      } else {
        toast.error(Object.values(result.errors)[0] ?? 'Could not update template')
      }
    })
  }

  const remove = (t: TemplateRow) => {
    if (!window.confirm(`Delete template "${t.name}" (${t.locale})? This cannot be undone.`)) return
    startTransition(async () => {
      const result = await deleteTemplateAction(t.id)
      if (result.ok) {
        toast.success('Template deleted')
        if (previewFor?.id === t.id) setPreviewFor(null)
        router.refresh()
      } else {
        toast.error(Object.values(result.errors)[0] ?? 'Could not delete template')
      }
    })
  }

  const err = (key: string) => errors[key] && <p className="text-destructive mt-1 text-xs">{errors[key]}</p>

  return (
    <div className="space-y-4">
      {(mock.EMAIL || mock.SMS) && (
        <div className="text-muted-foreground flex items-center gap-2 rounded-md border border-dashed border-amber-500/60 bg-amber-500/10 px-3 py-2 text-xs">
          <FlaskConical className="size-3.5 text-amber-600 dark:text-amber-400" />
          Mock messaging mode is active — sends using these templates are simulated, never delivered.
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          {templates.length} template{templates.length === 1 ? '' : 's'}
        </p>
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-3.5" />
          New template
        </Button>
      </div>

      {templates.length === 0 ? (
        <EmptyState
          icon="FileText"
          title="No templates yet"
          description="Create a template to give reps a consistent, pre-approved starting point for email and SMS."
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-3.5" />
              New template
            </Button>
          }
        />
      ) : (
        <div className="scroll-x rounded-lg border">
          <table className="w-full min-w-[46rem] text-sm tabular-nums">
            <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
              <tr className="border-b">
                <th className="px-3 py-2 text-left">Template</th>
                <th className="px-3 py-2 text-left">Channel</th>
                <th className="px-3 py-2 text-left">Locale</th>
                <th className="px-3 py-2 text-left">Active</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="hover:bg-muted/40 border-b last:border-0">
                  <td className="px-3 py-2">
                    <p className="font-medium">{t.name}</p>
                    <p className="text-muted-foreground font-mono text-xs">{t.key}</p>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className="gap-1 text-xs">
                      {t.channel === 'EMAIL' ? <Mail className="size-3" /> : <MessageSquareText className="size-3" />}
                      {t.channel === 'EMAIL' ? 'Email' : 'SMS'}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs uppercase">{t.locale}</td>
                  <td className="px-3 py-2">
                    <Switch checked={t.isActive} onCheckedChange={() => toggleActive(t)} disabled={pending} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setPreview(null)
                          setPreviewFor(t)
                        }}
                        title="Preview"
                      >
                        <Eye className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(t)} title="Edit">
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => remove(t)} title="Delete" disabled={pending}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Editor */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Edit template' : 'New template'}</DialogTitle>
            <DialogDescription>
              Variables: {KNOWN_VARIABLES.map((v) => `{{${v}}}`).join(' ')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="tpl-name">Name</Label>
                <Input
                  id="tpl-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="mt-1"
                />
                {err('name')}
              </div>
              <div>
                <Label htmlFor="tpl-key">Key</Label>
                <Input
                  id="tpl-key"
                  value={form.key}
                  onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
                  placeholder="follow_up_email"
                  className="mt-1 font-mono"
                />
                {err('key')}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="tpl-channel">Channel</Label>
                <NativeSelect
                  id="tpl-channel"
                  className={`${selectClass} mt-1 w-full`}
                  value={form.channel}
                  onChange={(e) => setForm((f) => ({ ...f, channel: e.target.value as 'EMAIL' | 'SMS' }))}
                >
                  <option value="EMAIL">Email</option>
                  <option value="SMS">SMS</option>
                </NativeSelect>
              </div>
              <div>
                <Label htmlFor="tpl-locale">Locale</Label>
                <NativeSelect
                  id="tpl-locale"
                  className={`${selectClass} mt-1 w-full`}
                  value={form.locale}
                  onChange={(e) => setForm((f) => ({ ...f, locale: e.target.value }))}
                >
                  <option value="en">English (en)</option>
                  <option value="es">Spanish (es)</option>
                </NativeSelect>
                {err('locale')}
              </div>
            </div>
            {form.channel === 'EMAIL' && (
              <div>
                <Label htmlFor="tpl-subject">Subject</Label>
                <Input
                  id="tpl-subject"
                  value={form.subject}
                  onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
                  className="mt-1"
                />
                {err('subject')}
              </div>
            )}
            <div>
              <Label htmlFor="tpl-body">Body</Label>
              <Textarea
                id="tpl-body"
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                rows={6}
                className="mt-1"
              />
              {err('body')}
            </div>
            <div>
              <Label htmlFor="tpl-desc">Description (internal)</Label>
              <Input
                id="tpl-desc"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                className="mt-1"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={form.isActive}
                onCheckedChange={(checked) => setForm((f) => ({ ...f, isActive: Boolean(checked) }))}
              />
              Active — visible to reps in the composer
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditorOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={pending}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              {form.id ? 'Save changes' : 'Create template'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview */}
      <Dialog
        open={previewFor !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewFor(null)
            setPreview(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Preview: {previewFor?.name}</DialogTitle>
            <DialogDescription>Rendered against a real client record, exactly as it would send.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <NativeSelect
              aria-label="Preview client"
              className={`${selectClass} w-full`}
              value={previewClientId}
              onChange={(e) => {
                setPreview(null)
                setPreviewClientId(e.target.value)
              }}
            >
              {clients.length === 0 && <option value="">No clients in your scope</option>}
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.locale})
                </option>
              ))}
            </NativeSelect>
            {!previewClientId ? (
              <p className="text-muted-foreground py-4 text-sm">Pick a client to render the preview.</p>
            ) : preview === null ? (
              <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
                <Loader2 className="size-4 animate-spin" /> Rendering…
              </div>
            ) : preview === 'error' ? (
              <p className="text-destructive py-4 text-sm">Preview failed — try another client.</p>
            ) : (
              <div className="bg-muted/40 space-y-1 rounded-md border p-3 text-sm">
                {preview.subject && <p className="font-medium">{preview.subject}</p>}
                <p className="whitespace-pre-wrap">{preview.body}</p>
                {preview.unresolved.length > 0 && (
                  <p className="text-destructive pt-1 text-xs">
                    Unresolved for this client: {preview.unresolved.map((v) => `{{${v}}}`).join(', ')} — a send
                    to them would be blocked.
                  </p>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
