'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, Pencil, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  saveCysDefinitionAction,
  toggleCysDefinitionAction,
  type DefinitionInput,
} from './actions'
import { CYS_DATA_TYPES, CYS_SOURCE_TYPES, SOURCE_PATH_HINTS, SOURCE_TYPE_LABELS } from './constants'

export type EditableDefinition = {
  id: string
  key: string
  label: string
  groupName: string
  position: number
  isRequired: boolean
  dataType: string
  sourceType: (typeof CYS_SOURCE_TYPES)[number]
  sourcePath: string | null
  helpText: string | null
  isActive: boolean
}

const EMPTY: Omit<EditableDefinition, 'id'> = {
  key: '',
  label: '',
  groupName: 'General',
  position: 0,
  isRequired: true,
  dataType: 'string',
  sourceType: 'CLIENT_FIELD',
  sourcePath: '',
  helpText: '',
  isActive: true,
}

export function DefinitionEditor({ definition }: { definition?: EditableDefinition }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState<Omit<EditableDefinition, 'id'>>(definition ?? EMPTY)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const submit = () => {
    setErrors({})
    setError(null)
    startTransition(async () => {
      const input: DefinitionInput = {
        id: definition?.id,
        key: form.key,
        label: form.label,
        groupName: form.groupName,
        position: form.position,
        isRequired: form.isRequired,
        dataType: form.dataType as DefinitionInput['dataType'],
        sourceType: form.sourceType,
        sourcePath: form.sourcePath || undefined,
        helpText: form.helpText || undefined,
        isActive: form.isActive,
      }
      const result = await saveCysDefinitionAction(input)
      if (result.ok) {
        toast.success(result.message ?? 'Saved.')
        setOpen(false)
        if (!definition) setForm(EMPTY)
        router.refresh()
      } else {
        setErrors(result.fieldErrors ?? {})
        setError(result.error)
      }
    })
  }

  const err = (key: string) =>
    errors[key] ? <p className="text-destructive text-xs">{errors[key]}</p> : null

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setForm(definition ?? EMPTY)
      }}
    >
      <DialogTrigger
        render={
          definition ? (
            <Button variant="ghost" size="icon-sm" aria-label={`Edit ${definition.label}`} />
          ) : (
            <Button size="sm" />
          )
        }
      >
        {definition ? <Pencil /> : (
          <>
            <Plus />
            Add field
          </>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{definition ? `Edit "${definition.label}"` : 'Add a CYS field'}</DialogTitle>
          <DialogDescription>
            Defines one line of the CYS handover package and where its value is pulled from.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="cys-key">Key</Label>
            <Input
              id="cys-key"
              value={form.key}
              onChange={(e) => set('key', e.target.value)}
              placeholder="utility_account_number"
              disabled={Boolean(definition)}
            />
            {err('key')}
          </div>
          <div className="space-y-1">
            <Label htmlFor="cys-label">Label</Label>
            <Input
              id="cys-label"
              value={form.label}
              onChange={(e) => set('label', e.target.value)}
              placeholder="Utility account number"
            />
            {err('label')}
          </div>
          <div className="space-y-1">
            <Label htmlFor="cys-group">Group</Label>
            <Input
              id="cys-group"
              value={form.groupName}
              onChange={(e) => set('groupName', e.target.value)}
            />
            {err('groupName')}
          </div>
          <div className="space-y-1">
            <Label htmlFor="cys-position">Position</Label>
            <Input
              id="cys-position"
              type="number"
              min={0}
              value={form.position}
              onChange={(e) => set('position', Number(e.target.value) || 0)}
            />
            {err('position')}
          </div>
          <div className="space-y-1">
            <Label htmlFor="cys-source-type">Source</Label>
            <NativeSelect
              id="cys-source-type"
              value={form.sourceType}
              onChange={(e) => set('sourceType', e.target.value as (typeof CYS_SOURCE_TYPES)[number])}
              className="border-input bg-background h-8 w-full rounded-md border px-2 text-sm outline-none"
            >
              {CYS_SOURCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SOURCE_TYPE_LABELS[t]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cys-data-type">Data type</Label>
            <NativeSelect
              id="cys-data-type"
              value={form.dataType}
              onChange={(e) => set('dataType', e.target.value)}
              className="border-input bg-background h-8 w-full rounded-md border px-2 text-sm outline-none"
            >
              {CYS_DATA_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="cys-source-path">Source path</Label>
            <Input
              id="cys-source-path"
              value={form.sourcePath ?? ''}
              onChange={(e) => set('sourcePath', e.target.value)}
              placeholder={SOURCE_PATH_HINTS[form.sourceType]}
              disabled={form.sourceType === 'MANUAL'}
            />
            <p className="text-muted-foreground text-xs">{SOURCE_PATH_HINTS[form.sourceType]}</p>
            {err('sourcePath')}
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="cys-help">Help text</Label>
            <Textarea
              id="cys-help"
              value={form.helpText ?? ''}
              onChange={(e) => set('helpText', e.target.value)}
              rows={2}
            />
            {err('helpText')}
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="cys-required"
              checked={form.isRequired}
              onCheckedChange={(v) => set('isRequired', v === true)}
            />
            <Label htmlFor="cys-required">Required for approval</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="cys-active"
              checked={form.isActive}
              onCheckedChange={(v) => set('isActive', v === true)}
            />
            <Label htmlFor="cys-active">Active</Label>
          </div>

          {error && <p className="text-destructive text-sm sm:col-span-2">{error}</p>}

          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              Save field
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function ActiveToggle({ id, label, isActive }: { id: string; label: string; isActive: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Switch
      checked={isActive}
      disabled={pending}
      aria-label={`${label} active`}
      onCheckedChange={(next) =>
        startTransition(async () => {
          const result = await toggleCysDefinitionAction({ id, isActive: next === true })
          if (result.ok) toast.success(result.message ?? 'Saved.')
          else toast.error(result.error)
          router.refresh()
        })
      }
    />
  )
}
