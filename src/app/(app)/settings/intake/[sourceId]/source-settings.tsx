'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowDown, ArrowUp, KeyRound, Loader2, RefreshCw, Save, X } from 'lucide-react'
import type { IntakeSourceKind } from '@prisma/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { NativeSelect } from '@/components/ui/native-select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { relativeTime } from '@/lib/format'
import { CRM_FIELDS, DEDUPE_KEYS, flattenKeys, type DedupeKey } from '@/lib/intake/mapping'
import { CopyValue } from '../new-source-dialog'
import { rotateIntakeSecret, syncIntakeSource, updateIntakeSource } from '../actions'

type Option = { id: string; name: string }

export type SourceView = {
  id: string
  kind: IntakeSourceKind
  name: string
  slug: string
  isEnabled: boolean
  fieldMapping: Record<string, string>
  dedupeKeys: string[]
  defaultOwnerId: string | null
  defaultLeadSourceId: string | null
  sheetId: string | null
  sheetTab: string | null
  lastRowCursor: number
  lastSyncAt: string | null
  lastSyncStatus: string | null
  lastError: string | null
}

const DEDUPE_LABELS: Record<DedupeKey, string> = {
  email: 'Email address',
  phone: 'Phone number',
  name: 'First + last name',
}

export function SourceSettings({
  source,
  owners,
  leadSources,
  canManage,
  sheetsMock,
}: {
  source: SourceView
  owners: Option[]
  leadSources: Option[]
  canManage: boolean
  sheetsMock: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [mapping, setMapping] = useState<Record<string, string>>(source.fieldMapping)
  const [dedupeKeys, setDedupeKeys] = useState<string[]>(source.dedupeKeys)
  const [sample, setSample] = useState('')
  const [sheetId, setSheetId] = useState(source.sheetId ?? '')
  const [sheetTab, setSheetTab] = useState(source.sheetTab ?? 'Sheet1')
  const [syncing, setSyncing] = useState(false)
  const [rotated, setRotated] = useState<string | null>(null)
  const [rotateOpen, setRotateOpen] = useState(false)

  const webhookUrl = typeof window !== 'undefined' ? `${window.location.origin}/api/intake/${source.slug}` : ''

  const sampleKeys = useMemo(() => {
    if (!sample.trim()) return []
    try {
      return flattenKeys(JSON.parse(sample))
    } catch {
      return null // invalid JSON
    }
  }, [sample])

  const save = (patch: Parameters<typeof updateIntakeSource>[0], success = 'Saved.') => {
    startTransition(async () => {
      const result = await updateIntakeSource(patch)
      if (result.ok) {
        toast.success(success)
        router.refresh()
      } else {
        toast.error(result.error ?? Object.values(result.fieldErrors ?? {})[0] ?? 'Could not save.')
      }
    })
  }

  const moveDedupe = (index: number, dir: -1 | 1) => {
    const next = [...dedupeKeys]
    const target = index + dir
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setDedupeKeys(next)
    save({ sourceId: source.id, dedupeKeys: next as DedupeKey[] }, 'Dedupe order saved.')
  }

  const sync = () => {
    setSyncing(true)
    startTransition(async () => {
      const result = await syncIntakeSource(source.id)
      setSyncing(false)
      if (result.ok) toast.success(result.message)
      else toast.error(result.error ?? 'Sync failed.')
      router.refresh()
    })
  }

  const rotate = () => {
    startTransition(async () => {
      const result = await rotateIntakeSecret(source.id)
      if (result.ok) {
        setRotated(result.secret)
        router.refresh()
      } else {
        toast.error(result.error ?? 'Could not rotate the secret.')
        setRotateOpen(false)
      }
    })
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            Delivery
            {canManage && (
              <label className="flex items-center gap-2 text-sm font-normal">
                <span className="text-muted-foreground">{source.isEnabled ? 'Enabled' : 'Disabled'}</span>
                <Switch
                  checked={source.isEnabled}
                  disabled={pending}
                  onCheckedChange={(v) =>
                    save({ sourceId: source.id, isEnabled: v }, v ? 'Source enabled.' : 'Source disabled — deliveries will 404.')
                  }
                />
              </label>
            )}
          </CardTitle>
          <CardDescription>
            Send a JSON POST signed with{' '}
            <code className="text-xs">X-Intake-Signature: sha256=HMAC_SHA256(sha256_hex(secret), raw body)</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="text-xs">Webhook URL</Label>
            <CopyValue value={webhookUrl} label="webhook URL" />
          </div>

          {canManage && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setRotateOpen(true)} disabled={pending}>
                <KeyRound className="size-3.5" />
                Rotate secret
              </Button>
              <span className="text-muted-foreground text-xs">Invalidates the current secret immediately.</span>
            </div>
          )}

          <div className="space-y-2 border-t pt-3">
            <Label className="text-xs">Duplicate matching — first hit wins</Label>
            {dedupeKeys.map((key, i) => (
              <div key={key} className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground w-4 text-xs tabular-nums">{i + 1}.</span>
                <span className="flex-1">{DEDUPE_LABELS[key as DedupeKey] ?? key}</span>
                {canManage && (
                  <>
                    <Button variant="ghost" size="icon-xs" aria-label="Move up" disabled={i === 0 || pending} onClick={() => moveDedupe(i, -1)}>
                      <ArrowUp className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Move down"
                      disabled={i === dedupeKeys.length - 1 || pending}
                      onClick={() => moveDedupe(i, 1)}
                    >
                      <ArrowDown className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Remove"
                      disabled={dedupeKeys.length <= 1 || pending}
                      onClick={() => {
                        const next = dedupeKeys.filter((k) => k !== key)
                        setDedupeKeys(next)
                        save({ sourceId: source.id, dedupeKeys: next as DedupeKey[] }, 'Dedupe keys saved.')
                      }}
                    >
                      <X className="size-3" />
                    </Button>
                  </>
                )}
              </div>
            ))}
            {canManage &&
              DEDUPE_KEYS.filter((k) => !dedupeKeys.includes(k)).map((k) => (
                <Button
                  key={k}
                  variant="outline"
                  size="xs"
                  disabled={pending}
                  onClick={() => {
                    const next = [...dedupeKeys, k]
                    setDedupeKeys(next)
                    save({ sourceId: source.id, dedupeKeys: next as DedupeKey[] }, 'Dedupe keys saved.')
                  }}
                >
                  + {DEDUPE_LABELS[k]}
                </Button>
              ))}
          </div>

          <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="src-owner" className="text-xs">
                Default owner
              </Label>
              <NativeSelect
                id="src-owner"
                value={source.defaultOwnerId ?? ''}
                disabled={!canManage || pending}
                onChange={(e) => save({ sourceId: source.id, defaultOwnerId: e.target.value || null }, 'Default owner saved.')}
                className="border-input bg-background h-8 w-full rounded-md border px-2 text-sm outline-none disabled:opacity-50"
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
              <Label htmlFor="src-leadsource" className="text-xs">
                Default lead source
              </Label>
              <NativeSelect
                id="src-leadsource"
                value={source.defaultLeadSourceId ?? ''}
                disabled={!canManage || pending}
                onChange={(e) =>
                  save({ sourceId: source.id, defaultLeadSourceId: e.target.value || null }, 'Default lead source saved.')
                }
                className="border-input bg-background h-8 w-full rounded-md border px-2 text-sm outline-none disabled:opacity-50"
              >
                <option value="">None</option>
                {leadSources.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          {source.kind === 'GOOGLE_SHEET' && (
            <div className="space-y-3 border-t pt-3">
              <div className="flex items-center gap-2">
                <Label className="text-xs">Google Sheet sync</Label>
                {sheetsMock && <Badge variant="secondary">Mock provider — synthetic rows</Badge>}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="src-sheetid" className="text-xs">
                    Sheet ID
                  </Label>
                  <Input id="src-sheetid" value={sheetId} onChange={(e) => setSheetId(e.target.value)} disabled={!canManage} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="src-sheettab" className="text-xs">
                    Tab
                  </Label>
                  <Input id="src-sheettab" value={sheetTab} onChange={(e) => setSheetTab(e.target.value)} disabled={!canManage} />
                </div>
              </div>
              {canManage && (
                <div className="flex flex-wrap items-center gap-2">
                  {(sheetId !== (source.sheetId ?? '') || sheetTab !== (source.sheetTab ?? 'Sheet1')) && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => save({ sourceId: source.id, sheetId, sheetTab }, 'Sheet settings saved.')}
                    >
                      <Save className="size-3.5" />
                      Save sheet settings
                    </Button>
                  )}
                  <Button size="sm" onClick={sync} disabled={syncing || pending || !source.sheetId}>
                    {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                    Sync now
                  </Button>
                  <span className="text-muted-foreground text-xs">
                    Cursor at row {source.lastRowCursor}
                    {source.lastSyncAt ? ` · last sync ${relativeTime(source.lastSyncAt)}` : ' · never synced'}
                  </span>
                </div>
              )}
              {source.lastSyncStatus && <p className="text-muted-foreground text-xs">{source.lastSyncStatus}</p>}
              {source.lastError && <p className="text-destructive text-xs">{source.lastError}</p>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Field mapping</CardTitle>
          <CardDescription>
            Which incoming payload key fills each CRM field. Dot-paths reach nested values (e.g.{' '}
            <code className="text-xs">contact.email</code>).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="src-sample" className="text-xs">
              Sample payload (optional — fills the key suggestions)
            </Label>
            <Textarea
              id="src-sample"
              value={sample}
              onChange={(e) => setSample(e.target.value)}
              placeholder='{"first_name": "Ada", "contact": {"email": "ada@example.test"}}'
              className="h-20 font-mono text-xs"
            />
            {sampleKeys === null && <p className="text-destructive text-xs">Not valid JSON.</p>}
            {sampleKeys && sampleKeys.length > 0 && (
              <p className="text-muted-foreground text-xs">{sampleKeys.length} keys detected.</p>
            )}
          </div>
          <datalist id="sample-keys">
            {(sampleKeys ?? []).map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
          <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
            {CRM_FIELDS.map((field) => (
              <div key={field.key} className="flex items-center gap-2">
                <span className="w-32 shrink-0 text-sm">
                  {field.label}
                  {'required' in field && field.required && <span className="text-destructive">*</span>}
                </span>
                <Input
                  value={mapping[field.key] ?? ''}
                  onChange={(e) => setMapping((m) => ({ ...m, [field.key]: e.target.value }))}
                  placeholder="incoming key"
                  list="sample-keys"
                  disabled={!canManage}
                  className="h-8 font-mono text-xs"
                />
              </div>
            ))}
          </div>
          {canManage && (
            <Button size="sm" disabled={pending} onClick={() => save({ sourceId: source.id, fieldMapping: mapping }, 'Mapping saved.')}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              Save mapping
            </Button>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={rotateOpen}
        onOpenChange={(v) => {
          setRotateOpen(v)
          if (!v) setRotated(null)
        }}
      >
        <DialogContent className="max-w-md">
          {rotated ? (
            <>
              <DialogHeader>
                <DialogTitle>New signing secret</DialogTitle>
                <DialogDescription>
                  Shown once. Update every caller — requests signed with the old secret are now rejected.
                </DialogDescription>
              </DialogHeader>
              <CopyValue value={rotated} label="signing secret" />
              <DialogFooter>
                <Button
                  size="sm"
                  onClick={() => {
                    setRotateOpen(false)
                    setRotated(null)
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Rotate signing secret?</DialogTitle>
                <DialogDescription>
                  The current secret stops working immediately, and deliveries signed with it will fail with 401 until
                  callers are updated.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => setRotateOpen(false)} disabled={pending}>
                  Cancel
                </Button>
                <Button variant="destructive" size="sm" onClick={rotate} disabled={pending}>
                  {pending && <Loader2 className="size-3.5 animate-spin" />}
                  Rotate
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
