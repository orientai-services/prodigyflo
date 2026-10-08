'use client'

import { useActionState, useEffect, useState, useTransition } from 'react'
import { CalendarPlus, Link2, Megaphone, RefreshCw, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import {
  createCampaignAction, sendTestLeadAction, setSpendCapAction,
  type MetaActionState,
} from './actions'
import {
  recheckConnection, rematchLeads, setCycleLength, startSpendCycle,
  type AdsActionState,
} from './ads-actions'

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

/* ------------------------------------------------ Meta Ads (SCS General 1) */

/** Runs one argument-free ads action in a transition and reports the result as a toast. */
function useAdsAction(run: () => Promise<AdsActionState>) {
  const [pending, startTransition] = useTransition()
  const fire = (after?: (res: AdsActionState) => void) =>
    startTransition(async () => {
      const res = await run()
      if (res.ok) toast.success(res.ok)
      if (res.error) toast.error(res.error)
      after?.(res)
    })
  return [pending, fire] as const
}

/** "Start new cycle" behind a confirm dialog. The server closes the open cycle and starts the next. */
export function StartCycleButton({ current }: { current: { number: number; spendText: string } | null }) {
  const [open, setOpen] = useState(false)
  const [pending, fire] = useAdsAction(startSpendCycle)
  const next = (current?.number ?? 0) + 1

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button className="h-10 sm:h-8"><CalendarPlus data-icon="inline-start" /> Start new cycle</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Start cycle {next}?</DialogTitle>
          <DialogDescription>
            {current
              ? `This closes cycle ${current.number} at ${current.spendText} and starts cycle ${next} now.`
              : `This starts cycle ${next} now.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" className="h-10 sm:h-8">Cancel</Button>} />
          <Button
            className="h-10 sm:h-8"
            disabled={pending}
            onClick={() => fire((res) => { if (res.ok) setOpen(false) })}
          >
            {pending ? 'Starting…' : `Start cycle ${next}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Cycle length in days (1 to 90). Applies to the open cycle and every cycle after it. */
export function CycleLengthForm({ days }: { days: number }) {
  const [value, setValue] = useState(String(days))
  const [pending, startTransition] = useTransition()

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    startTransition(async () => {
      const res = await setCycleLength(Number(value))
      if (res.ok) toast.success(res.ok)
      if (res.error) toast.error(res.error)
    })
  }

  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <div className="space-y-1.5">
        <Label htmlFor="cycle-length" className="text-xs">Cycle length (days)</Label>
        <Input
          id="cycle-length"
          type="number"
          inputMode="numeric"
          min={1}
          max={90}
          step={1}
          required
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-10 w-24 text-right sm:h-8"
        />
      </div>
      <Button type="submit" variant="outline" className="h-10 sm:h-8" disabled={pending || Number(value) === days}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </form>
  )
}

export function RecheckButton() {
  const [pending, fire] = useAdsAction(recheckConnection)
  return (
    <Button type="button" variant="outline" className="h-10 sm:h-8" disabled={pending} onClick={() => fire()}>
      <RefreshCw data-icon="inline-start" className={pending ? 'motion-safe:animate-spin' : undefined} />
      {pending ? 'Checking…' : 'Re-check now'}
    </Button>
  )
}

export function RematchButton() {
  const [pending, fire] = useAdsAction(rematchLeads)
  return (
    <Button type="button" variant="outline" className="h-10 sm:h-8" disabled={pending} onClick={() => fire()}>
      <Link2 data-icon="inline-start" />
      {pending ? 'Matching…' : 'Re-match leads to ads'}
    </Button>
  )
}
