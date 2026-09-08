'use client'

import { useActionState, useState } from 'react'
import { CheckCheck, HeartHandshake } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import {
  confirmNurtureTouchAction,
  logNurtureTouchAction,
  type NurtureActionState,
} from './actions'

const KIND_OPTIONS = [
  ['VIDEO', 'Personalized video'],
  ['EMAIL', 'Email'],
  ['SMS', 'Text message'],
  ['CALL_PREP', 'Call prep'],
] as const

const KIND_URL_PLACEHOLDER: Record<(typeof KIND_OPTIONS)[number][0], string> = {
  VIDEO: 'https://loom.com/share/…',
  EMAIL: 'https://… (optional link you referenced)',
  SMS: 'https://… (optional link you texted)',
  CALL_PREP: 'https://… (optional prep material)',
}

/** "Log nurture touch" dialog — defaults to the Phase 2 personalized video. */
export function LogNurtureDialog({
  clientId,
  clientName,
  variant = 'default',
}: {
  clientId: string
  clientName: string
  variant?: 'default' | 'outline'
}) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<(typeof KIND_OPTIONS)[number][0]>('VIDEO')
  // Controlled fields: a rejected server action must not wipe what was typed.
  const [url, setUrl] = useState('')
  const [note, setNote] = useState('')
  const [state, action, pending] = useActionState<NurtureActionState, FormData>(
    async (prev, formData) => {
      const result = await logNurtureTouchAction(prev, formData)
      if (result.ok) {
        setUrl('')
        setNote('')
        setOpen(false)
      }
      return result
    },
    {},
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" variant={variant}>
            <HeartHandshake data-slot="icon" /> Log nurture touch
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log a nurture touch</DialogTitle>
          <DialogDescription>
            Record the personal touch you already sent {clientName} before the call — the send
            itself always happens outside the CRM, by you.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-4">
          <input type="hidden" name="clientId" value={clientId} />
          <div className="space-y-1.5">
            <Label htmlFor={`nurture-kind-${clientId}`}>What went out</Label>
            <NativeSelect
              id={`nurture-kind-${clientId}`}
              name="kind"
              required
              className="w-full"
              value={kind}
              onChange={(e) => setKind(e.target.value as (typeof KIND_OPTIONS)[number][0])}
            >
              {KIND_OPTIONS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`nurture-url-${clientId}`}>
              Link <span className="text-muted-foreground font-normal">(https only, optional)</span>
            </Label>
            <Input
              id={`nurture-url-${clientId}`}
              name="url"
              type="url"
              inputMode="url"
              maxLength={2048}
              placeholder={KIND_URL_PLACEHOLDER[kind]}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`nurture-note-${clientId}`}>
              Note <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Textarea
              id={`nurture-note-${clientId}`}
              name="note"
              rows={3}
              maxLength={2000}
              placeholder="What made it personal — what you referenced, what you promised for the call…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {state.error && <p className="text-danger text-sm">{state.error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? 'Logging…' : 'Log touch'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** One-click "the client saw it" confirmation on a sent touch. */
export function ConfirmTouchButton({ touchId }: { touchId: string }) {
  const [state, action, pending] = useActionState<NurtureActionState, FormData>(
    confirmNurtureTouchAction,
    {},
  )

  return (
    <form action={action} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="touchId" value={touchId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        <CheckCheck data-slot="icon" /> {pending ? 'Confirming…' : 'Mark confirmed'}
      </Button>
      {state.error && <p className="text-danger text-xs">{state.error}</p>}
    </form>
  )
}
