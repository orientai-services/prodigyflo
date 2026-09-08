'use client'

import { useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { BookmarkPlus, Loader2, Users2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { deleteFilterAction, saveFilterAction } from './list-actions'

export type SavedFilterChip = {
  id: string
  name: string
  params: Record<string, string>
  isShared: boolean
  mine: boolean
  ownerName: string
  canDelete: boolean
}

const FILTER_KEYS = ['q', 'stage', 'owner', 'team', 'status', 'sort'] as const

function currentParams(search: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of FILTER_KEYS) {
    const value = search.get(key)
    if (value) out[key] = value
  }
  return out
}

function sameParams(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if ((a[k] ?? '') !== (b[k] ?? '')) return false
  return true
}

export function SavedFilters({ filters }: { filters: SavedFilterChip[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const [pending, startTransition] = useTransition()

  const active = currentParams(search)
  const hasActive = Object.keys(active).length > 0

  const apply = (chip: SavedFilterChip) => {
    const next = new URLSearchParams()
    for (const [k, v] of Object.entries(chip.params)) next.set(k, v)
    router.push(`${pathname}?${next}`)
  }

  const remove = (chip: SavedFilterChip) => {
    startTransition(async () => {
      const result = await deleteFilterAction({ id: chip.id })
      if (result.ok) {
        toast.success(`Deleted “${chip.name}”.`)
        router.refresh()
      } else {
        toast.error(result.error ?? 'Could not delete this view.')
      }
    })
  }

  const save = () => {
    startTransition(async () => {
      const result = await saveFilterAction({ name, params: active, isShared: shared })
      if (result.ok) {
        toast.success(shared ? `Saved “${name}” and shared it with the team.` : `Saved “${name}”.`)
        setOpen(false)
        setName('')
        setShared(false)
        router.refresh()
      } else {
        toast.error(result.error ?? 'Could not save this view.')
      }
    })
  }

  if (filters.length === 0 && !hasActive) return null

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {filters.length > 0 && (
        <span className="text-muted-foreground mr-0.5 text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
          Saved views
        </span>
      )}

      {filters.map((chip) => {
        const isActive = sameParams(chip.params, active)
        return (
          <span
            key={chip.id}
            className={cn(
              'group/chip inline-flex h-7 items-center gap-1 rounded-full border pr-1 pl-2.5 text-xs transition-colors',
              isActive
                ? 'border-primary/40 bg-primary/10 text-primary font-medium'
                : 'bg-surface-raised hover:bg-muted',
            )}
          >
            <button type="button" onClick={() => apply(chip)} className="outline-none">
              {chip.name}
            </button>
            {chip.isShared && (
              <Tooltip>
                <TooltipTrigger render={<Users2 className="text-muted-foreground size-3" />} />
                <TooltipContent>
                  Shared with the whole team{chip.mine ? '' : ` by ${chip.ownerName}`}
                </TooltipContent>
              </Tooltip>
            )}
            {chip.canDelete && (
              <button
                type="button"
                onClick={() => remove(chip)}
                aria-label={`Delete saved view ${chip.name}`}
                className="hover:bg-muted-foreground/15 rounded-full p-0.5 opacity-0 transition-opacity group-hover/chip:opacity-100 focus-visible:opacity-100"
              >
                <X className="size-3" />
              </button>
            )}
          </span>
        )
      })}

      {hasActive && (
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          <BookmarkPlus className="size-3.5" />
          Save this view
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Save this view</DialogTitle>
            <DialogDescription>
              Keeps the current search, filters and sort as a one-click chip above the client list.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="view-name">Name</Label>
              <Input
                id="view-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                placeholder="e.g. My overdue intake"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && name.trim()) save()
                }}
              />
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={shared} onCheckedChange={(c) => setShared(c === true)} />
              Share with the whole team
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={pending || !name.trim()} onClick={save}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              Save view
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
