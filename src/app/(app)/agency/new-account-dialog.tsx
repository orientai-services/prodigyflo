'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Building2 } from 'lucide-react'
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
import { createClientAccountAction, type CreateAccountState } from './actions'

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function NewAccountDialog() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [state, action, pending] = useActionState<CreateAccountState, FormData>(
    createClientAccountAction,
    {},
  )

  // Close + toast exactly once per successful create. The action state object
  // is replaced on every dispatch, so identity is the "new result" signal.
  const handled = useRef<CreateAccountState | null>(null)
  useEffect(() => {
    if (state.ok && handled.current !== state) {
      handled.current = state
      toast.success(`${state.name} is ready`, {
        description: 'Pipeline, roles, intake survey, and document package are all set up.',
      })
      setOpen(false)
      setName('')
      setSlug('')
      setSlugTouched(false)
    }
  }, [state])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm">
            <Building2 data-slot="icon" /> New client account
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New client account</DialogTitle>
          <DialogDescription>
            A fresh account under your agency — it comes bootstrapped with the default pipeline,
            roles, intake survey, and submission package.
          </DialogDescription>
        </DialogHeader>

        <form action={action} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="acct-name">Account name</Label>
            <Input
              id="acct-name"
              name="name"
              required
              placeholder="Acme Solar Co."
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (!slugTouched) setSlug(slugify(e.target.value))
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acct-slug">Slug</Label>
            <Input
              id="acct-slug"
              name="slug"
              required
              placeholder="acme-solar"
              className="font-mono"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true)
                setSlug(e.target.value)
              }}
            />
            <p className="text-muted-foreground text-xs">
              At least 3 characters — lowercase letters, numbers, and dashes. Unique across the
              whole platform.
            </p>
          </div>

          {state.error && <p className="text-danger text-sm">{state.error}</p>}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? 'Creating…' : 'Create account'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
