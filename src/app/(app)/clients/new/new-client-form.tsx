'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, UserPlus, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { NativeSelect } from '@/components/ui/native-select'
import { createClientAction, type CreateClientResult } from './actions'

type Option = { value: string; label: string }

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-md border px-2 text-sm outline-none focus-visible:ring-3'

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

const EMPTY = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  preferredLanguage: 'en',
  preferredContact: 'phone',
  ownerId: '',
  leadSourceId: '',
  estimatedValue: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  postalCode: '',
  note: '',
}

export function NewClientForm({ owners, leadSources }: { owners: Option[]; leadSources: Option[] }) {
  const router = useRouter()
  const [values, setValues] = useState(EMPTY)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [duplicates, setDuplicates] = useState<NonNullable<CreateClientResult['duplicates']> | null>(null)
  const [pending, startTransition] = useTransition()

  const set = (key: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }))

  const submit = (force: boolean) => {
    setFieldErrors({})
    startTransition(async () => {
      const result = await createClientAction({ ...values, force })
      if (result.ok && result.clientId) {
        toast.success('Client created')
        router.push(`/clients/${result.clientId}`)
      } else if (result.duplicates) {
        setDuplicates(result.duplicates)
      } else {
        setFieldErrors(result.fieldErrors ?? {})
        toast.error(result.error ?? 'Could not create the client.')
      }
    })
  }

  const allMatches = duplicates ? [...duplicates.exact, ...duplicates.possible] : []

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit(false)
      }}
      className="max-w-3xl space-y-4 px-4 py-5 sm:px-6"
    >
      {duplicates && (
        <div className="border-warning/50 bg-warning/10 rounded-lg border p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Users className="size-4" />
            This looks like {allMatches.length === 1 ? 'an existing client' : 'existing clients'}
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {allMatches.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{m.name}</span>
                <span className="text-muted-foreground text-xs">
                  {m.email} · matched on {m.matchedOn === 'name_postal' ? 'name + postal code' : m.matchedOn}
                </span>
                <Button variant="outline" size="xs" render={<Link href={`/clients/${m.id}`} />}>
                  Use existing
                </Button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setDuplicates(null)}>
              Keep editing
            </Button>
            <Button type="button" size="sm" disabled={pending} onClick={() => submit(true)}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              Create anyway
            </Button>
          </div>
        </div>
      )}

      <div className="bg-card grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
        <Field id="nc-first" label="First name" error={fieldErrors.firstName}>
          <Input id="nc-first" value={values.firstName} onChange={set('firstName')} autoFocus />
        </Field>
        <Field id="nc-last" label="Last name" error={fieldErrors.lastName}>
          <Input id="nc-last" value={values.lastName} onChange={set('lastName')} />
        </Field>
        <Field id="nc-email" label="Email" error={fieldErrors.email}>
          <Input id="nc-email" type="email" value={values.email} onChange={set('email')} />
        </Field>
        <Field id="nc-phone" label="Phone" error={fieldErrors.phone}>
          <Input id="nc-phone" value={values.phone} onChange={set('phone')} />
        </Field>
        <Field id="nc-lang" label="Preferred language" error={fieldErrors.preferredLanguage}>
          <NativeSelect id="nc-lang" value={values.preferredLanguage} onChange={set('preferredLanguage')} className={selectClass}>
            <option value="en">English</option>
            <option value="es">Spanish</option>
          </NativeSelect>
        </Field>
        <Field id="nc-contact" label="Preferred contact" error={fieldErrors.preferredContact}>
          <NativeSelect id="nc-contact" value={values.preferredContact} onChange={set('preferredContact')} className={selectClass}>
            <option value="phone">Phone</option>
            <option value="sms">SMS</option>
            <option value="email">Email</option>
          </NativeSelect>
        </Field>
      </div>

      <div className="bg-card grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
        <Field id="nc-owner" label="Owner" error={fieldErrors.ownerId}>
          <NativeSelect id="nc-owner" value={values.ownerId} onChange={set('ownerId')} className={selectClass}>
            <option value="">Unassigned</option>
            {owners.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="nc-source" label="Lead source" error={fieldErrors.leadSourceId}>
          <NativeSelect id="nc-source" value={values.leadSourceId} onChange={set('leadSourceId')} className={selectClass}>
            <option value="">None</option>
            {leadSources.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="nc-value" label="Estimated value (USD)" error={fieldErrors.estimatedValue}>
          <Input id="nc-value" inputMode="decimal" value={values.estimatedValue} onChange={set('estimatedValue')} />
        </Field>
      </div>

      <div className="bg-card grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
        <Field id="nc-line1" label="Address line 1 (optional)" error={fieldErrors.line1}>
          <Input id="nc-line1" value={values.line1} onChange={set('line1')} />
        </Field>
        <Field id="nc-line2" label="Address line 2" error={fieldErrors.line2}>
          <Input id="nc-line2" value={values.line2} onChange={set('line2')} />
        </Field>
        <Field id="nc-city" label="City" error={fieldErrors.city}>
          <Input id="nc-city" value={values.city} onChange={set('city')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field id="nc-state" label="State" error={fieldErrors.state}>
            <Input id="nc-state" value={values.state} onChange={set('state')} />
          </Field>
          <Field id="nc-zip" label="Postal code" error={fieldErrors.postalCode}>
            <Input id="nc-zip" value={values.postalCode} onChange={set('postalCode')} />
          </Field>
        </div>
      </div>

      <div className="bg-card rounded-lg border p-4">
        <Field id="nc-note" label="Internal note (optional)" error={fieldErrors.note}>
          <Textarea id="nc-note" rows={2} value={values.note} onChange={set('note')} />
        </Field>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => router.push('/clients')}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <UserPlus className="size-3.5" />}
          Create client
        </Button>
      </div>
    </form>
  )
}
