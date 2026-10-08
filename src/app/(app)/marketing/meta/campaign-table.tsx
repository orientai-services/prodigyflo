'use client'

import { Fragment, useState, useTransition } from 'react'
import { ChevronRight, ImageOff } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { currency, humanize } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import type { AdNode, AdSetNode, CampaignNode, Metrics, RemainderNode } from '@/lib/meta/ads/read'
import {
  GLOSSARY, StatusBadge, Term, count, ctrText, frequencyText, money, unitCost,
} from './views/parts'
import {
  setAdSetStatusAction, setCampaignStatusAction, updateBudgetAction,
  type MetaActionState,
} from './actions'

/**
 * Campaign → ad set → ad tree for the Meta Ads page. Desktop gets an
 * expandable table (horizontal scroll inside the card, md+ only); phones get a
 * stacked card list. Tapping an ad opens its creative summary in a sheet.
 * Write controls render only when writes are switched on server-side, and every
 * write still re-checks the object's ad account on the server.
 */

type TreeRow = CampaignNode | RemainderNode

/** Ads that have spent money for this many days in a row without a lead get a badge. */
const NO_LEAD_BADGE_DAYS = 3

function budgetText(daily: number | null, lifetime: number | null): React.ReactNode {
  if (daily) return <>{currency(daily)}<span className="text-muted-foreground">/day</span></>
  if (lifetime) return <>{currency(lifetime)}<span className="text-muted-foreground"> total</span></>
  return <span className="text-muted-foreground">—</span>
}

function ctaWords(cta: string | null): string | null {
  return cta ? humanize(cta) : null
}

function StatusSwitch({
  active, disabled, onToggle, label,
}: { active: boolean; disabled?: boolean; onToggle: (next: boolean) => void; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Switch size="sm" checked={active} disabled={disabled} onCheckedChange={onToggle} aria-label={label} />
      <Badge variant={active ? 'secondary' : 'outline'}>{active ? 'Active' : 'Paused'}</Badge>
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
          <Button variant="ghost" size="sm" className="h-7 px-2 font-normal tabular-nums" title="Change the daily budget">
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
        </form>
      </PopoverContent>
    </Popover>
  )
}

/** Plain <img>: Meta's thumbnail URLs expire, so they're never proxied, stored or optimized. */
function Thumb({ src, alt, className }: { src: string | null; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return (
      <span
        aria-hidden
        className={cn('bg-muted text-muted-foreground flex shrink-0 items-center justify-center rounded-md border', className)}
      >
        <ImageOff className="size-3.5" />
      </span>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn('bg-muted shrink-0 rounded-md border object-cover', className)}
    />
  )
}

function AdFlags({ ad }: { ad: AdNode }) {
  const { zeroLeadStreakDays, highFrequency, lowCtr } = ad.flags
  const showNoLeads = zeroLeadStreakDays >= NO_LEAD_BADGE_DAYS
  if (!showNoLeads && !highFrequency && !lowCtr) return null
  return (
    <span className="flex flex-wrap gap-1">
      {showNoLeads && (
        <Badge variant="outline" className="text-warning border-warning/40">
          <Term tip={GLOSSARY.noLeads}>No leads {zeroLeadStreakDays} days</Term>
        </Badge>
      )}
      {highFrequency && (
        <Badge variant="outline" className="text-warning border-warning/40">
          <Term tip={GLOSSARY.seenTooOften}>Seen too often</Term>
        </Badge>
      )}
      {lowCtr && (
        <Badge variant="outline" className="text-warning border-warning/40">
          <Term tip={GLOSSARY.lowCtr}>Low click rate</Term>
        </Badge>
      )}
    </span>
  )
}

/** The four numbers every row shows, as table cells. */
function MetricCells({ m, dense }: { m: Metrics; dense?: boolean }) {
  const pad = dense ? 'px-3 py-2' : 'px-3 py-2.5'
  return (
    <>
      <td className={cn(pad, 'text-right')}>{money(m.spend)}</td>
      <td className={cn(pad, 'text-right')}>{count(m.impressions)}</td>
      <td className={cn(pad, 'text-right')}>{count(m.linkClicks)}</td>
      <td className={cn(pad, 'text-right')}>{count(m.leads)}</td>
      <td className={cn(pad, 'text-right')}>{unitCost(m.cpl)}</td>
      <td className={cn(pad, 'text-right')}>{ctrText(m.ctr)}</td>
    </>
  )
}

/** Compact numbers for phone rows. Spans only, so it can sit inside a button. */
function MetricLine({ m }: { m: Metrics }) {
  return (
    <span className="text-muted-foreground mt-1 grid grid-cols-4 gap-2 text-xs tabular-nums">
      <span className="text-foreground font-medium">{money(m.spend)}</span>
      <span>{count(m.leads)} leads</span>
      <span>{unitCost(m.cpl)}/lead</span>
      <span>{ctrText(m.ctr)} CTR</span>
    </span>
  )
}

function AdSheet({ ad, onClose }: { ad: AdNode | null; onClose: () => void }) {
  return (
    <Sheet open={ad !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {ad && (
          <>
            <SheetHeader>
              <SheetTitle className="pr-8">{ad.name}</SheetTitle>
              <SheetDescription>What people see in this ad. Edit it in Meta Ads Manager.</SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4 pb-6">
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge status={ad.effectiveStatus ?? ad.status} removed={ad.removed} />
                <AdFlags ad={ad} />
              </div>
              {ad.creative.thumbnailUrl && (
                <Thumb src={ad.creative.thumbnailUrl} alt={`Preview of ${ad.name}`} className="aspect-square w-full max-w-72" />
              )}
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-muted-foreground text-xs">Headline</dt>
                  <dd className="mt-0.5 font-medium">{ad.creative.headline ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Text</dt>
                  <dd className="mt-0.5 whitespace-pre-line">{ad.creative.body ?? '—'}</dd>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <dt className="text-muted-foreground text-xs">Button</dt>
                    <dd className="mt-0.5">{ctaWords(ad.creative.cta) ?? '—'}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground text-xs">Goes to</dt>
                    <dd className="mt-0.5 truncate">{ad.creative.linkHost ?? '—'}</dd>
                  </div>
                </div>
              </dl>
              <dl className="grid grid-cols-2 gap-3 border-t pt-4 text-sm tabular-nums">
                <div><dt className="text-muted-foreground text-xs">Spend</dt><dd>{money(ad.metrics.spend)}</dd></div>
                <div><dt className="text-muted-foreground text-xs"><Term tip={GLOSSARY.leads}>Leads</Term></dt><dd>{count(ad.metrics.leads)}</dd></div>
                <div><dt className="text-muted-foreground text-xs"><Term tip={GLOSSARY.cpl}>Cost per lead</Term></dt><dd>{unitCost(ad.metrics.cpl)}</dd></div>
                <div><dt className="text-muted-foreground text-xs"><Term tip={GLOSSARY.ctr}>CTR</Term></dt><dd>{ctrText(ad.metrics.ctr)}</dd></div>
                <div><dt className="text-muted-foreground text-xs"><Term tip={GLOSSARY.reach}>Reach</Term></dt><dd>{count(ad.metrics.reach)}</dd></div>
                <div><dt className="text-muted-foreground text-xs"><Term tip={GLOSSARY.frequency}>Frequency</Term></dt><dd>{frequencyText(ad.metrics.frequency)}</dd></div>
              </dl>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function useStatusToggle() {
  const [, startTransition] = useTransition()
  return (kind: 'campaign' | 'adset', id: string, next: boolean) => {
    startTransition(async () => {
      const status = next ? 'ACTIVE' : 'PAUSED'
      const res = kind === 'campaign'
        ? await setCampaignStatusAction(id, status)
        : await setAdSetStatusAction(id, status)
      if (res.ok) toast.success(res.ok)
      if (res.error) toast.error(res.error)
    })
  }
}

function isCampaign(row: TreeRow): row is CampaignNode {
  return row.kind === 'campaign'
}

/* ---------------------------------------------------------------- desktop */

function DesktopTable({
  tree, writes, selectedId, onOpenAd,
}: { tree: TreeRow[]; writes: boolean; selectedId?: string; onOpenAd: (ad: AdNode) => void }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => (selectedId ? { [selectedId]: true } : {}))
  const toggle = useStatusToggle()
  const flip = (id: string) => setExpanded((e) => ({ ...e, [id]: !e[id] }))

  return (
    <div className="scroll-x hidden rounded-lg border md:block">
      <table className="w-full min-w-[64rem] text-sm tabular-nums">
        <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
          <tr>
            <th className="w-8 px-2 py-2"><span className="sr-only">Expand</span></th>
            <th className="px-3 py-2 text-left">Campaign / ad set / ad</th>
            <th className="px-3 py-2 text-left">Status</th>
            <th className="px-3 py-2 text-right">Budget</th>
            <th className="px-3 py-2 text-right">Spend</th>
            <th className="px-3 py-2 text-right"><Term tip={GLOSSARY.impressions}>Impr.</Term></th>
            <th className="px-3 py-2 text-right">Link clicks</th>
            <th className="px-3 py-2 text-right"><Term tip={GLOSSARY.leads}>Leads</Term></th>
            <th className="px-3 py-2 text-right"><Term tip={GLOSSARY.cpl}>CPL</Term></th>
            <th className="px-3 py-2 text-right"><Term tip={GLOSSARY.ctr}>CTR</Term></th>
          </tr>
        </thead>
        <tbody>
          {tree.map((row) => {
            if (!isCampaign(row)) {
              return (
                <tr key="remainder" className="text-muted-foreground border-b last:border-0">
                  <td />
                  <td className="px-3 py-2.5 italic">
                    <Term tip={GLOSSARY.remainder}>{row.name}</Term>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge variant="outline" className="text-muted-foreground">Removed</Badge>
                  </td>
                  <td />
                  <MetricCells m={row.metrics} />
                </tr>
              )
            }
            const c = row
            const open = expanded[c.id] ?? false
            return (
              <Fragment key={c.id}>
                <tr className={cn('border-b last:border-0', selectedId === c.id && 'bg-primary/5')}>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      onClick={() => flip(c.id)}
                      className="text-muted-foreground hover:text-foreground rounded p-1"
                      aria-expanded={open}
                      aria-label={`${open ? 'Hide' : 'Show'} ad sets in ${c.name}`}
                    >
                      <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} />
                    </button>
                  </td>
                  <td className="max-w-[22rem] px-3 py-2.5">
                    <span className="block truncate font-medium">{c.name}</span>
                    {c.objective && <span className="text-muted-foreground text-xs">{humanize(c.objective.replace(/^OUTCOME_/, ''))}</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    {writes ? (
                      <StatusSwitch active={c.status === 'ACTIVE'} onToggle={(n) => toggle('campaign', c.id, n)} label={`Turn ${c.name} on or off`} />
                    ) : (
                      <StatusBadge status={c.status} />
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {writes && c.dailyBudget
                      ? <BudgetPopover targetType="campaign" targetId={c.id} dailyBudget={c.dailyBudget} />
                      : budgetText(c.dailyBudget, c.lifetimeBudget)}
                  </td>
                  <MetricCells m={c.metrics} />
                </tr>
                {open && c.adSets.length === 0 && (
                  <tr className="bg-surface-sunk/40 border-b last:border-0">
                    <td />
                    <td colSpan={9} className="text-muted-foreground px-3 py-2 pl-9 text-xs">No ad sets in this campaign yet.</td>
                  </tr>
                )}
                {open && c.adSets.map((s) => (
                  <AdSetRows key={s.id} adSet={s} writes={writes} onOpenAd={onOpenAd} expanded={expanded[s.id] ?? false} onFlip={() => flip(s.id)} toggle={toggle} />
                ))}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function AdSetRows({
  adSet: s, writes, onOpenAd, expanded, onFlip, toggle,
}: {
  adSet: AdSetNode
  writes: boolean
  onOpenAd: (ad: AdNode) => void
  expanded: boolean
  onFlip: () => void
  toggle: (kind: 'campaign' | 'adset', id: string, next: boolean) => void
}) {
  return (
    <>
      <tr className="bg-surface-sunk/40 border-b text-[0.8125rem] last:border-0">
        <td />
        <td className="max-w-[22rem] px-3 py-2 pl-6">
          <button
            type="button"
            onClick={onFlip}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Hide' : 'Show'} ads in ${s.name}`}
            className="hover:text-foreground flex max-w-full items-center gap-1.5 rounded text-left"
          >
            <ChevronRight className={cn('text-muted-foreground size-3.5 shrink-0 transition-transform', expanded && 'rotate-90')} />
            <span className="truncate">{s.name}</span>
            <span className="text-muted-foreground shrink-0 text-xs">· {s.ads.length} {s.ads.length === 1 ? 'ad' : 'ads'}</span>
          </button>
        </td>
        <td className="px-3 py-2">
          {writes ? (
            <StatusSwitch active={s.status === 'ACTIVE'} onToggle={(n) => toggle('adset', s.id, n)} label={`Turn ${s.name} on or off`} />
          ) : (
            <StatusBadge status={s.status} />
          )}
        </td>
        <td className="px-3 py-2 text-right">
          {writes && s.dailyBudget
            ? <BudgetPopover targetType="adset" targetId={s.id} dailyBudget={s.dailyBudget} />
            : budgetText(s.dailyBudget, s.lifetimeBudget)}
        </td>
        <MetricCells m={s.metrics} dense />
      </tr>
      {expanded && s.ads.length === 0 && (
        <tr className="bg-surface-sunk/20 border-b last:border-0">
          <td />
          <td colSpan={9} className="text-muted-foreground px-3 py-2 pl-14 text-xs">No ads in this ad set yet.</td>
        </tr>
      )}
      {expanded && s.ads.map((ad) => (
        <tr key={ad.id} className={cn('bg-surface-sunk/20 border-b text-[0.8125rem] last:border-0', ad.removed && 'text-muted-foreground')}>
          <td />
          <td className="max-w-[22rem] px-3 py-2 pl-12">
            <div className="flex items-start gap-2">
              <button
                type="button"
                onClick={() => onOpenAd(ad)}
                aria-label={`Show the ad ${ad.name}`}
                className="shrink-0 rounded"
              >
                <Thumb src={ad.creative.thumbnailUrl} alt="" className="size-8" />
              </button>
              <span className="min-w-0">
                <button
                  type="button"
                  onClick={() => onOpenAd(ad)}
                  className="block max-w-full truncate rounded text-left hover:underline"
                >
                  {ad.name}
                </button>
                <AdFlags ad={ad} />
              </span>
            </div>
          </td>
          <td className="px-3 py-2"><StatusBadge status={ad.effectiveStatus ?? ad.status} removed={ad.removed} /></td>
          <td />
          <MetricCells m={ad.metrics} dense />
        </tr>
      ))}
    </>
  )
}

/* ------------------------------------------------------------------ phone */

function PhoneList({ tree, selectedId, onOpenAd }: { tree: TreeRow[]; selectedId?: string; onOpenAd: (ad: AdNode) => void }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => (selectedId ? { [selectedId]: true } : {}))
  const flip = (id: string) => setExpanded((e) => ({ ...e, [id]: !e[id] }))

  return (
    <ul className="space-y-3 md:hidden">
      {tree.map((row) => {
        if (!isCampaign(row)) {
          return (
            <li key="remainder">
              <Card className="text-muted-foreground px-4 py-3">
                <p className="text-sm italic"><Term tip={GLOSSARY.remainder}>{row.name}</Term></p>
                <MetricLine m={row.metrics} />
              </Card>
            </li>
          )
        }
        const c = row
        const open = expanded[c.id] ?? false
        return (
          <li key={c.id}>
            <Card className={cn('gap-0 py-0', selectedId === c.id && 'ring-primary/40 ring-2')}>
              <button
                type="button"
                onClick={() => flip(c.id)}
                aria-expanded={open}
                className="flex min-h-12 w-full items-start gap-2 px-4 py-3 text-left"
              >
                <ChevronRight aria-hidden className={cn('text-muted-foreground mt-0.5 size-4 shrink-0 transition-transform', open && 'rotate-90')} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-start justify-between gap-2">
                    <span className="truncate text-sm font-medium">{c.name}</span>
                    <StatusBadge status={c.status} />
                  </span>
                  <span className="text-muted-foreground text-xs">{budgetText(c.dailyBudget, c.lifetimeBudget)}</span>
                  <MetricLine m={c.metrics} />
                </span>
              </button>
              {open && (
                <div className="border-t">
                  {c.adSets.length === 0 && <p className="text-muted-foreground px-4 py-3 text-xs">No ad sets in this campaign yet.</p>}
                  {c.adSets.map((s) => (
                    <div key={s.id} className="bg-surface-sunk/40 border-b px-4 py-3 last:border-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 truncate text-[0.8125rem] font-medium">{s.name}</p>
                        <StatusBadge status={s.status} />
                      </div>
                      <MetricLine m={s.metrics} />
                      {s.ads.length > 0 && (
                        <ul className="mt-2 space-y-1.5">
                          {s.ads.map((ad) => (
                            <li key={ad.id} className={cn('bg-card rounded-lg border p-2', ad.removed && 'text-muted-foreground')}>
                              <button
                                type="button"
                                onClick={() => onOpenAd(ad)}
                                className="flex min-h-10 w-full items-start gap-2.5 text-left"
                              >
                                <Thumb src={ad.creative.thumbnailUrl} alt="" className="size-10" />
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-start justify-between gap-2">
                                    <span className="truncate text-[0.8125rem]">{ad.name}</span>
                                    <StatusBadge status={ad.effectiveStatus ?? ad.status} removed={ad.removed} />
                                  </span>
                                  <MetricLine m={ad.metrics} />
                                </span>
                              </button>
                              <div className="mt-1.5 pl-[3.125rem] empty:hidden"><AdFlags ad={ad} /></div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </li>
        )
      })}
    </ul>
  )
}

export function CampaignTable({
  tree, writesEnabled, canManage, selectedId,
}: { tree: TreeRow[]; writesEnabled: boolean; canManage: boolean; selectedId?: string }) {
  const [openAd, setOpenAd] = useState<AdNode | null>(null)
  const writes = writesEnabled && canManage

  return (
    <div className="space-y-2">
      <DesktopTable tree={tree} writes={writes} selectedId={selectedId} onOpenAd={setOpenAd} />
      <PhoneList tree={tree} selectedId={selectedId} onOpenAd={setOpenAd} />
      {!writesEnabled && (
        <p className="text-muted-foreground text-xs">Changes are made in Meta Ads Manager.</p>
      )}
      <AdSheet ad={openAd} onClose={() => setOpenAd(null)} />
    </div>
  )
}
