'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Check, Copy, Loader2, Plus } from 'lucide-react'
import type { IntakeSourceKind } from '@prisma/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { createIntakeSource } from './actions'

type Option = { id: string; name: string }

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2">
      <code className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1.5 font-mono text-xs" title={value}>
        {value}
      </code>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  )
}

export function NewSourceDialog({ owners, leadSources }: { owners: Option[]; leadSources: Option[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [kind, setKind] = useState<IntakeSourceKind>('WEB_FORM')
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [ownerId, setOwnerId] = useState('')
  const [leadSourceId, setLeadSourceId] = useState('')
  const [sheetId, setSheetId] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  // Set once after a successful create; the secret is never retrievable again.
  const [created, setCreated] = useState<{ slug: string; secret: string } | null>(null)

  const reset = () => {
    setKind('WEB_FORM')
    setName('')
    setSlug('')
    setSlugTouched(false)
    setOwnerId('')
    setLeadSourceId('')
    setSheetId('')
    setErrors({})
    setCreated(null)
  }

  const submit = () => {
    startTransition(async () => {
      const result = await createIntakeSource({
        name,
        kind,
        slug,
        defaultOwnerId: ownerId || undefined,
        defaultLeadSourceId: leadSourceId || undefined,
        sheetId: sheetId || undefined,
      })
      if (result.ok) {
        setCreated({ slug: result.slug, secret: result.secret })
        setErrors({})
        toast.success('Intake source created.')
        router.refresh()
      } else {
        setErrors(result.fieldErrors ?? { form: result.error ?? 'Could not create the source.' })
      }
    })
  }

  const webhookUrl =
    created && typeof window !== 'undefined' ? `${window.location.origin}/api/intake/${created.slug}` : ''

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        New source
      </Button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v)
          if (!v) reset()
        }}
      >
        <DialogContent className="max-w-md">
          {created ? (
            <>
              <DialogHeader>
                <DialogTitle>Save your signing secret</DialogTitle>
                <DialogDescription>
                  This secret is shown once and cannot be recovered — only rotated. Sign each request with
                  HMAC-SHA256 using the SHA-256 hex of this secret as the key, and send it as{' '}
                  <code className="text-xs">X-Intake-Signature: sha256=&lt;hex&gt;</code>.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Webhook URL</Label>
                  <CopyValue value={webhookUrl} label="webhook URL" />
                </div>
                <div>
                  <Label className="text-xs">Signing secret</Label>
                  <CopyValue value={created.secret} label="signing secret" />
                </div>
              </div>
              <DialogFooter>
                <Button
                  size="sm"
                  onClick={() => {
                    setOpen(false)
                    reset()
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>New intake source</DialogTitle>
                <DialogDescription>Each source gets its own webhook URL and signing secret.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="intake-name">Name</Label>
                  <Input
                    id="intake-name"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      if (!slugTouched) setSlug(slugify(e.target.value))
                    }}
                    placeholder="Website lead form"
                  />
                  {errors.name && <p className="text-destructive text-xs">{errors.name}</p>}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="intake-kind">Kind</Label>
                  <NativeSelect
                    id="intake-kind"
                    value={kind}
                    onChange={(e) => setKind(e.target.value as IntakeSourceKind)}
                    className="border-input bg-background h-8 w-full rounded-md border px-2 text-sm outline-none"
                  >
                    <option value="WEB_FORM">Web form (webhook)</option>
                    <option value="GOOGLE_SHEET">Google Sheet</option>
                    <option value="CSV_IMPORT">CSV import (webhook)</option>
                  </NativeSelect>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="intake-slug">Slug</Label>
                  <Input
                    id="intake-slug"
                    value={slug}
                    onChange={(e) => {
                      setSlugTouched(true)
                      setSlug(e.target.value)
                    }}
                    placeholder="website-lead-form"
                  />
                  <p className="text-muted-foreground text-xs">Webhook URL: /api/intake/{slug || '…'}</p>
                  {errors.slug && <p className="text-destructive text-xs">{errors.slug}</p>}
                </div>
                {kind === 'GOOGLE_SHEET' && (
                  <div className="space-y-1">
                    <Label htmlFor="intake-sheet">Sheet ID</Label>
                    <Input
                      id="intake-sheet"
                      value={sheetId}
                      onChange={(e) => setSheetId(e.target.value)}
                      placeholder="1AbC…"
                    />
                    {errors.sheetId && <p className="text-destructive text-xs">{errors.sheetId}</p>}
                  </div>
                )}
                <div className="space-y-1">
                  <Label htmlFor="intake-owner">Default owner</Label>
                  <NativeSelect
                    id="intake-owner"
                    value={ownerId}
                    onChange={(e) => setOwnerId(e.target.value)}
                    className="border-input bg-background h-8 w-full rounded-md border px-2 text-sm outline-none"
                  >
                    <option value="">Unassigned</option>
                    {owners.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="intake-leadsource">Default lead source</Label>
                  <NativeSelect
                    id="intake-leadsource"
                    value={leadSourceId}
                    onChange={(e) => setLeadSourceId(e.target.value)}
                    className="border-input bg-background h-8 w-full rounded-md border px-2 text-sm outline-none"
                  >
                    <option value="">None</option>
                    {leadSources.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                {errors.form && <p className="text-destructive text-xs">{errors.form}</p>}
              </div>
              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={pending}>
                  Cancel
                </Button>
                <Button size="sm" onClick={submit} disabled={pending || !name || !slug}>
                  {pending && <Loader2 className="size-3.5 animate-spin" />}
                  Create source
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
