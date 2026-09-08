'use client'

import { Fragment, useState, useTransition } from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { currency, number } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Microbar } from './spark'
import {
  setAdSetStatusAction, setCampaignStatusAction, updateBudgetAction,
  type MetaActionState,
} from './actions'

export type AdSetRowView = {
  id: string
  name: string
  status: string
  dailyBudget: number
  spend: number
}

export type CampaignRowView = {
  id: string
  externalId: string
  name: string
  objective: string
  status: string
  dailyBudget: number
  spendCap: number | null
  spend: number
  impressions: number
  clicks: number
  leads: number
  trend7: number[]
  adSets: AdSetRowView[]
}

function StatusSwitch({
  active, disabled, onToggle, label,
}: { active: boolean; disabled?: boolean; onToggle: (next: boolean) => void; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Switch size="sm" checked={active} disabled={disabled} onCheckedChange={onToggle} aria-label={label} />
      <Badge variant={active ? 'secondary' : 'outline'}>{active ? 'active' : 'paused'}</Badge>
    </span>
  )
}

function BudgetPopover({
  targetType, targetId, dailyBudget,
}: { targetType: 'campaign' | 'adset'; targetId: string; dailyBudget: number }) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  function submit(formData: FormData) {
    startTransition(async () => {
      const res: MetaActionState = await updateBudgetAction({}, formData)
      if (res.ok) {
        toast.success(res.ok)
        setOpen(false)
      }
      if (res.error) toast.error(res.error)
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="h-7 px-2 font-normal tabular-nums" title="Edit daily budget">
            {currency(dailyBudget)}<span className="text-muted-foreground">/day</span>
          </Button>
        }
      />
      <PopoverContent className="w-56 p-3" align="end">
        <form action={submit} className="space-y-2">
          <p className="text-xs font-medium">Daily budget (USD)</p>
          <input type="hidden" name="targetType" value={targetType} />
          <input type="hidden" name="targetId" value={targetId} />
          <div className="flex items-center gap-2">
            <Input
              name="dailyBudget" type="number" min="1" step="1" defaultValue={dailyBudget || 1}
              className="h-8 text-right text-sm" aria-label="Daily budget" autoFocus
            />
            <Button type="submit" size="sm" disabled={pending}>{pending ? '…' : 'Set'}</Button>
          </div>
          <p className="text-muted-foreground text-[0.6875rem]">Per-day pacing — the lifetime cap is separate.</p>
        </form>
      </PopoverContent>
    </Popover>
  )
}

export function CampaignTable({
  campaigns, canManage, selectedId,
}: { campaigns: CampaignRowView[]; canManage: boolean; selectedId?: string }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [, startTransition] = useTransition()

  function toggleStatus(kind: 'campaign' | 'adset', id: string, next: boolean) {
    startTransition(async () => {
      const status = next ? 'ACTIVE' : 'PAUSED'
      const res = kind === 'campaign'
        ? await setCampaignStatusAction(id, status)
        : await setAdSetStatusAction(id, status)
      if (res.ok) toast.success(res.ok)
      if (res.error) toast.error(res.error)
    })
  }

  return (
    <div className="scroll-x rounded-lg border">
      <table className="w-full min-w-[64rem] text-sm tabular-nums">
        <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
          <tr>
            <th className="w-8 px-2 py-2" aria-label="Expand" />
            <th className="px-3 py-2 text-left">Campaign / ad set</th>
            <th className="px-3 py-2 text-left">Status</th>
            <th className="px-3 py-2 text-right">Daily budget</th>
            <th className="px-3 py-2 text-right">Spend</th>
            <th className="px-3 py-2 text-right">Spend cap</th>
            <th className="px-3 py-2 text-left">7d</th>
            <th className="px-3 py-2 text-right">Impr.</th>
            <th className="px-3 py-2 text-right">Clicks</th>
            <th className="px-3 py-2 text-right">Leads</th>
            <th className="px-3 py-2 text-right">CPL</th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c) => {
            const isOpen = expanded[c.id] ?? false
            const isSelected = selectedId === c.id
            return (
              <Fragment key={c.id}>
                <tr className={cn('border-b transition-colors last:border-0', isSelected && 'bg-primary/5')}>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      onClick={() => setExpanded((e) => ({ ...e, [c.id]: !isOpen }))}
                      className="text-muted-foreground hover:text-foreground rounded p-1"
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? 'Collapse' : 'Expand'} ad sets of ${c.name}`}
                    >
                      <ChevronRight className={cn('size-4 transition-transform', isOpen && 'rotate-90')} />
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <Link
                      href={`/marketing/meta?campaign=${c.id}`}
                      scroll={false}
                      className="font-medium hover:underline"
                    >
                      {c.name}
                    </Link>
                    <span className="text-muted-foreground ml-2 text-xs">{c.objective}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    {canManage ? (
                      <StatusSwitch
                        active={c.status === 'ACTIVE'}
                        onToggle={(next) => toggleStatus('campaign', c.id, next)}
                        label={`Toggle ${c.name}`}
                      />
                    ) : (
                      <Badge variant={c.status === 'ACTIVE' ? 'secondary' : 'outline'}>{c.status.toLowerCase()}</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {canManage
                      ? <BudgetPopover targetType="campaign" targetId={c.id} dailyBudget={c.dailyBudget} />
                      : <>{currency(c.dailyBudget)}<span className="text-muted-foreground">/day</span></>}
                  </td>
                  <td className="px-3 py-2.5 text-right">{currency(c.spend)}</td>
                  <td className="px-3 py-2.5 text-right">
                    {c.spendCap !== null
                      ? <span title="Lifetime spend cap">{currency(c.spendCap)}</span>
                      : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2.5"><Microbar data={c.trend7} /></td>
                  <td className="px-3 py-2.5 text-right">{number(c.impressions)}</td>
                  <td className="px-3 py-2.5 text-right">{number(c.clicks)}</td>
                  <td className="px-3 py-2.5 text-right">{number(c.leads)}</td>
                  <td className="px-3 py-2.5 text-right">{c.leads ? currency(c.spend / c.leads) : '—'}</td>
                </tr>
                {isOpen && c.adSets.length === 0 && (
                  <tr className="bg-surface-sunk/40 border-b last:border-0">
                    <td />
                    <td colSpan={10} className="text-muted-foreground px-3 py-2 pl-9 text-xs">
                      No ad sets synced for this campaign yet.
                    </td>
                  </tr>
                )}
                {isOpen && c.adSets.map((a) => (
                  <tr key={a.id} className="bg-surface-sunk/40 border-b text-[0.8125rem] last:border-0">
                    <td />
                    <td className="px-3 py-2 pl-9">
                      <span className="text-muted-foreground mr-1.5">↳</span>
                      {a.name}
                    </td>
                    <td className="px-3 py-2">
                      {canManage ? (
                        <StatusSwitch
                          active={a.status === 'ACTIVE'}
                          onToggle={(next) => toggleStatus('adset', a.id, next)}
                          label={`Toggle ${a.name}`}
                        />
                      ) : (
                        <Badge variant={a.status === 'ACTIVE' ? 'secondary' : 'outline'}>{a.status.toLowerCase()}</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canManage
                        ? <BudgetPopover targetType="adset" targetId={a.id} dailyBudget={a.dailyBudget} />
                        : <>{currency(a.dailyBudget)}<span className="text-muted-foreground">/day</span></>}
                    </td>
                    <td className="px-3 py-2 text-right">{currency(a.spend)}</td>
                    <td colSpan={6} />
                  </tr>
                ))}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
