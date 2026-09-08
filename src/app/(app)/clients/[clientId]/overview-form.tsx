'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { updateOverviewAction } from './actions'

export type OverviewFormValues = {
  firstName: string
  lastName: string
  email: string
  phone: string
  preferredLanguage: string
  preferredContact: string
  estimatedValue: string
  ownerId: string
  leadSourceId: string
  line1: string
  line2: string
  city: string
  state: string
  postalCode: string
}

type Option = { value: string; label: string }

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string
  label: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && <p className="text-danger text-xs">{error}</p>}
    </div>
  )
}

export function OverviewForm({
  clientId,
  initial,
  owners,
  leadSources,
  canReassign,
}: {
  clientId: string
  initial: OverviewFormValues
  owners: Option[]
  leadSources: Option[]
  canReassign: boolean
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [values, setValues] = useState(initial)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [pending, startTransition] = useTransition()

  const set = (key: keyof OverviewFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }))

  if (!editing) {
    return (
      <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
        <Pencil className="size-3.5" />
        Edit details
      </Button>
    )
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setFieldErrors({})
    startTransition(async () => {
      const result = await updateOverviewAction({ clientId, ...values })
      if (result.ok) {
        toast.success('Client details saved')
        setEditing(false)
        router.refresh()
      } else {
        setFieldErrors(result.fieldErrors ?? {})
        toast.error(result.error ?? 'Could not save changes.')
      }
    })
  }

  const selectClass =
    'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-md border px-2 text-sm outline-none focus-visible:ring-3'

  return (
    <form onSubmit={submit} className="bg-card mt-3 grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
      <Field id="ov-first" label="First name" error={fieldErrors.firstName}>
        <Input id="ov-first" value={values.firstName} onChange={set('firstName')} />
      </Field>
      <Field id="ov-last" label="Last name" error={fieldErrors.lastName}>
        <Input id="ov-last" value={values.lastName} onChange={set('lastName')} />
      </Field>
      <Field id="ov-email" label="Email" error={fieldErrors.email}>
        <Input id="ov-email" type="email" value={values.email} onChange={set('email')} />
      </Field>
      <Field id="ov-phone" label="Phone" error={fieldErrors.phone}>
        <Input id="ov-phone" value={values.phone} onChange={set('phone')} />
      </Field>

      <Field id="ov-lang" label="Preferred language" error={fieldErrors.preferredLanguage}>
        <NativeSelect id="ov-lang" value={values.preferredLanguage} onChange={set('preferredLanguage')} className={selectClass}>
          <option value="en">English</option>
          <option value="es">Spanish</option>
        </NativeSelect>
      </Field>
      <Field id="ov-contact" label="Preferred contact" error={fieldErrors.preferredContact}>
        <NativeSelect id="ov-contact" value={values.preferredContact} onChange={set('preferredContact')} className={selectClass}>
          <option value="phone">Phone</option>
          <option value="sms">SMS</option>
          <option value="email">Email</option>
        </NativeSelect>
      </Field>

      <Field id="ov-value" label="Estimated value (USD)" error={fieldErrors.estimatedValue}>
        <Input id="ov-value" inputMode="decimal" value={values.estimatedValue} onChange={set('estimatedValue')} />
      </Field>
      <Field id="ov-source" label="Lead source" error={fieldErrors.leadSourceId}>
        <NativeSelect id="ov-source" value={values.leadSourceId} onChange={set('leadSourceId')} className={selectClass}>
          <option value="">None</option>
          {leadSources.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </NativeSelect>
      </Field>

      {canReassign && (
        <Field id="ov-owner" label="Owner" error={fieldErrors.ownerId}>
          <NativeSelect id="ov-owner" value={values.ownerId} onChange={set('ownerId')} className={selectClass}>
            <option value="">Unassigned</option>
            {owners.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}

      <div className="sm:col-span-2 grid gap-3 border-t pt-3 sm:grid-cols-2">
        <Field id="ov-line1" label="Address line 1" error={fieldErrors.line1}>
          <Input id="ov-line1" value={values.line1} onChange={set('line1')} />
        </Field>
        <Field id="ov-line2" label="Address line 2" error={fieldErrors.line2}>
          <Input id="ov-line2" value={values.line2} onChange={set('line2')} />
        </Field>
        <Field id="ov-city" label="City" error={fieldErrors.city}>
          <Input id="ov-city" value={values.city} onChange={set('city')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field id="ov-state" label="State" error={fieldErrors.state}>
            <Input id="ov-state" value={values.state} onChange={set('state')} />
          </Field>
          <Field id="ov-zip" label="Postal code" error={fieldErrors.postalCode}>
            <Input id="ov-zip" value={values.postalCode} onChange={set('postalCode')} />
          </Field>
        </div>
      </div>

      <div className="sm:col-span-2 flex justify-end gap-2 border-t pt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setValues(initial)
            setFieldErrors({})
            setEditing(false)
          }}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {pending && <Loader2 className="size-3.5 animate-spin" />}
          Save changes
        </Button>
      </div>
    </form>
  )
}
