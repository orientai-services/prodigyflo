'use client'

import { useActionState, useEffect, useState } from 'react'
import { Building2, Megaphone, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import {
  createAdAccountAction, createCampaignAction, sendTestLeadAction, setSpendCapAction,
  type MetaActionState,
} from './actions'

export function CampaignDialog() {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState<MetaActionState, FormData>(createCampaignAction, {})

  // Close-on-success is derived during render (React's adjust-state pattern),
  // keeping the toast side effect alone in the effect.
  const [seen, setSeen] = useState<string | undefined>(undefined)
  if (state.ok && state.ok !== seen) {
    setSeen(state.ok)
    setOpen(false)
  }
  useEffect(() => {
    if (state.ok) toast.success(state.ok)
  }, [state])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm"><Megaphone data-slot="icon" /> New campaign</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a campaign</DialogTitle>
          <DialogDescription>
            Campaign-level setup: objective, daily budget, starting state. Ad sets and creatives are
            managed in Meta Ads Manager once connected.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="c-name">Name</Label>
            <Input id="c-name" name="name" required placeholder="Solar exit — Las Vegas leads" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="c-objective">Objective</Label>
              <NativeSelect id="c-objective" name="objective" defaultValue="LEADS" className="w-full">
                <option value="LEADS">Leads</option>
                <option value="TRAFFIC">Traffic</option>
                <option value="AWARENESS">Awareness</option>
                <option value="CONVERSIONS">Conversions</option>
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-budget">Daily budget (USD)</Label>
              <Input id="c-budget" name="dailyBudget" type="number" min="1" step="1" defaultValue="50" required />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="c-status">Start as</Label>
            <NativeSelect id="c-status" name="status" defaultValue="PAUSED" className="w-full">
              <option value="PAUSED">Paused (review first)</option>
              <option value="ACTIVE">Active</option>
            </NativeSelect>
          </div>
          {state.error && <p className="text-danger text-sm">{state.error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={pending}>{pending ? 'Creating…' : 'Create campaign'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function AdAccountDialog({ mode }: { mode: 'mock' | 'live' }) {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState<MetaActionState, FormData>(createAdAccountAction, {})

  const [seen, setSeen] = useState<string | undefined>(undefined)
  if (state.ok && state.ok !== seen) {
    setSeen(state.ok)
    setOpen(false)
  }
  useEffect(() => {
    if (state.ok) toast.success(state.ok)
  }, [state])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline"><Building2 data-slot="icon" /> New ad account</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create an ad account</DialogTitle>
          <DialogDescription>
            {mode === 'live'
              ? 'Creates a new account under the Business Manager via a System User token (META_BUSINESS_ID + META_SYSTEM_USER_TOKEN).'
              : 'Mock mode — this exercises the workflow and creates nothing real. Live creation needs META_BUSINESS_ID and META_SYSTEM_USER_TOKEN.'}
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="a-name">Account name</Label>
            <Input id="a-name" name="name" required placeholder="ProdigyFlo — Solar Exit" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="a-currency">Currency</Label>
              <NativeSelect id="a-currency" name="currency" defaultValue="USD" className="w-full">
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="MXN">MXN</option>
                <option value="CAD">CAD</option>
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a-timezone">Timezone id</Label>
              <Input id="a-timezone" name="timezone" defaultValue="1" required />
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            Timezone is Meta&apos;s numeric <code>timezone_id</code> from the Marketing API reference — not an IANA name.
          </p>
          {state.error && <p className="text-danger text-sm">{state.error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={pending}>{pending ? 'Creating…' : 'Create account'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Lifetime spend-cap editor for the campaign detail rail — min $100, never a daily number. */
export function SpendCapForm({ campaignId, spendCap }: { campaignId: string; spendCap: number | null }) {
  const [state, action, pending] = useActionState<MetaActionState, FormData>(setSpendCapAction, {})

  useEffect(() => {
    if (state.ok) toast.success(state.ok)
    if (state.error) toast.error(state.error)
  }, [state])

  return (
    <form action={action} className="space-y-1.5">
      <Label htmlFor={`cap-${campaignId}`} className="text-xs">Lifetime spend cap (USD, min $100)</Label>
      <div className="flex items-center gap-2">
        <input type="hidden" name="campaignId" value={campaignId} />
        <Input
          id={`cap-${campaignId}`} name="spendCap" type="number" min="100" step="1"
          defaultValue={spendCap ?? ''} placeholder="e.g. 2500"
          className="h-8 text-right text-sm"
        />
        <Button type="submit" size="sm" variant="outline" disabled={pending}>{pending ? '…' : 'Set cap'}</Button>
      </div>
      <p className="text-muted-foreground text-[0.6875rem]">A total ceiling for the campaign&apos;s life — separate from the daily budget.</p>
    </form>
  )
}

export function TestLeadButton() {
  const [state, action, pending] = useActionState<MetaActionState, FormData>(() => sendTestLeadAction(), {})

  useEffect(() => {
    if (state.ok) toast.success(state.ok)
    if (state.error) toast.error(state.error)
  }, [state])

  return (
    <form action={action}>
      <Button type="submit" size="sm" variant="outline" disabled={pending} title="Simulate a Lead Ads webhook delivery end to end">
        <Send data-slot="icon" /> {pending ? 'Sending…' : 'Send test lead'}
      </Button>
    </form>
  )
}
