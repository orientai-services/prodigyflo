'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import type { CallRouting } from '@prisma/client'
import { AlertCircle, ArrowDown, Loader2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { updateNumberAction } from './actions'
import type { MemberVM, NumberVM } from './types'

/**
 * What happens when this line rings — with the answer written out in plain
 * words underneath, because "FORWARD / TEAM / VOICEMAIL_ONLY" means nothing to
 * the person who has to live with the choice.
 */
export function RoutingDialog({
  number,
  members,
  open,
  onOpenChange,
}: {
  number: NumberVM | null
  members: MemberVM[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [friendlyName, setFriendlyName] = useState('')
  const [routing, setRouting] = useState<CallRouting>('VOICEMAIL_ONLY')
  const [forwardTo, setForwardTo] = useState('')
  const [teamUserIds, setTeamUserIds] = useState<string[]>([])
  const [greeting, setGreeting] = useState('')
  const [recordCalls, setRecordCalls] = useState(false)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)

  // Load the row's current settings the first time this dialog sees it.
  if (number && loadedFor !== number.id) {
    setLoadedFor(number.id)
    setFriendlyName(number.friendlyName)
    setRouting(number.routing)
    setForwardTo(number.forwardToDisplay ?? '')
    setTeamUserIds(number.teamUserIds)
    setGreeting(number.voicemailGreeting ?? '')
    setRecordCalls(number.recordCalls)
    setError(null)
  }

  if (!number) return null

  const reachable = members.filter((m) => m.hasPhone)
  const toggleMember = (id: string) =>
    setTeamUserIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))

  const save = () => {
    setError(null)
    startTransition(async () => {
      const res = await updateNumberAction({
        phoneNumberId: number.id,
        friendlyName,
        routing,
        forwardTo: routing === 'FORWARD' ? forwardTo : number.forwardTo,
        teamUserIds,
        voicemailGreeting: greeting,
        recordCalls,
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      toast.success('Call handling saved.')
      onOpenChange(false)
      router.refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{number.display}</DialogTitle>
          <DialogDescription>
            Everything about how this line answers. Changes take effect on the very next call.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="rt-label" className="text-xs font-medium">
              Label
            </Label>
            <Input
              id="rt-label"
              value={friendlyName}
              onChange={(e) => setFriendlyName(e.target.value)}
              className="h-8"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rt-routing" className="text-xs font-medium">
              When someone calls
            </Label>
            <NativeSelect
              id="rt-routing"
              size="sm"
              value={routing}
              onChange={(e) => setRouting(e.target.value as CallRouting)}
            >
              <option value="FORWARD">Ring one phone</option>
              <option value="TEAM">Ring the team, one after another</option>
              <option value="VOICEMAIL_ONLY">Go straight to voicemail</option>
            </NativeSelect>
          </div>

          {routing === 'FORWARD' && (
            <div className="space-y-1.5">
              <Label htmlFor="rt-forward" className="text-xs font-medium">
                Ring this number
              </Label>
              <Input
                id="rt-forward"
                value={forwardTo}
                onChange={(e) => setForwardTo(e.target.value)}
                placeholder="(702) 555-0199"
                className="h-8 font-mono tabular-nums"
              />
            </div>
          )}

          {routing === 'TEAM' && (
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Ring these people, in this order</Label>
              {reachable.length === 0 ? (
                <p className="text-muted-foreground rounded-md border border-dashed px-3 py-3 text-xs">
                  Nobody on this account has a phone number on their profile yet, so there is no one to ring. Add
                  numbers under Users &amp; access, or choose voicemail.
                </p>
              ) : (
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-1">
                  {reachable.map((m) => {
                    const position = teamUserIds.indexOf(m.id)
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => toggleMember(m.id)}
                        className={cn(
                          'flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors',
                          position >= 0 ? 'bg-brand-soft' : 'hover:bg-muted',
                        )}
                      >
                        <span>{m.name}</span>
                        {position >= 0 && (
                          <span className="text-muted-foreground text-xs tabular-nums">#{position + 1}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="rt-greeting" className="text-xs font-medium">
              Greeting
            </Label>
            <Textarea
              id="rt-greeting"
              value={greeting}
              onChange={(e) => setGreeting(e.target.value)}
              rows={2}
              placeholder="Thanks for calling. Please hold while we connect you."
              className="text-sm"
            />
            <p className="text-muted-foreground text-xs">
              Read aloud to the caller before anything else. Leave it blank for the standard greeting.
            </p>
          </div>

          <div className="flex items-start justify-between gap-3 rounded-md border p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Record answered calls</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                When on, the greeting also announces the recording — which is what keeps it lawful in two-party
                consent states. Recordings stay with the carrier; only a link is kept here.
              </p>
            </div>
            <Switch checked={recordCalls} onCheckedChange={setRecordCalls} />
          </div>

          <div className="bg-muted/40 rounded-md border p-3">
            <p className="text-muted-foreground text-xs font-medium">What a caller experiences</p>
            <ol className="mt-2 space-y-1 text-xs">
              <li>1. Hears {greeting.trim() ? '“' + greeting.trim().slice(0, 60) + '”' : 'the standard greeting'}</li>
              <li className="flex items-center gap-1">
                <ArrowDown className="text-muted-foreground size-3" />
                2.{' '}
                {routing === 'FORWARD'
                  ? `${forwardTo || 'the forwarding number'} rings for 20 seconds`
                  : routing === 'TEAM'
                    ? `${teamUserIds.length || 'no'} teammate${teamUserIds.length === 1 ? '' : 's'} ring in turn, 20 seconds each`
                    : 'goes straight to the beep'}
              </li>
              <li className="flex items-center gap-1">
                <ArrowDown className="text-muted-foreground size-3" />
                3. Leaves a voicemail if nobody picks up — and it lands on their timeline either way
              </li>
            </ol>
          </div>

          {error && (
            <p className="text-danger flex items-start gap-2 text-xs">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={pending}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
