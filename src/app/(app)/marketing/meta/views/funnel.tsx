import { AlertTriangle, Unplug } from 'lucide-react'
import { FunnelChart, type FunnelStep } from '@/components/charts/funnel-chart'
import { EmptyState } from '@/components/empty-state'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import type { FunnelRow, FunnelView as FunnelData } from '@/lib/meta/ads/read'
import { RangeTabs } from '../window-tabs'
import { GLOSSARY, Term, count, money, unitCost } from './parts'

const DOUBT_TIP =
  "ProdigyFlo and Meta count a different number of leads for this ad. Meta may be crediting another ad, or the lead form may be shared between ads."

function roasText(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(2)}×`
}

function steps(rows: FunnelRow[]): FunnelStep[] {
  const sum = (k: 'leads' | 'contacted' | 'booked' | 'sat' | 'sold') => rows.reduce((a, r) => a + r[k], 0)
  const raw = [
    { key: 'leads', label: 'Leads', count: sum('leads') },
    { key: 'contacted', label: 'Contacted', count: sum('contacted') },
    { key: 'booked', label: 'Booked', count: sum('booked') },
    { key: 'sat', label: 'Showed', count: sum('sat') },
    { key: 'sold', label: 'Sold', count: sum('sold') },
  ]
  const top = raw[0].count
  return raw.map((s, i) => {
    const prev = i === 0 ? null : raw[i - 1].count
    return {
      ...s,
      ofTotal: top ? (s.count / top) * 100 : null,
      stepConversion: prev ? (s.count / prev) * 100 : null,
      droppedOff: prev === null ? 0 : Math.max(0, prev - s.count),
    }
  })
}

function DoubtBadge() {
  return (
    <Badge variant="outline" className="text-warning border-warning/40">
      <Term tip={DOUBT_TIP}>Numbers disagree</Term>
    </Badge>
  )
}

export function FunnelViewSection({ data, base }: { data: FunnelData; base?: string }) {
  const rows = data.rows
  const totals = {
    spend: rows.reduce((a, r) => a + r.spend, 0),
    revenue: rows.reduce((a, r) => a + r.revenue, 0),
  }

  return (
    <div className="space-y-4">
      <RangeTabs active={data.range} base={base} />

      {data.leadOrgMatches === false && (
        <Alert variant="destructive">
          <Unplug />
          <AlertTitle>Leads can&apos;t be matched</AlertTitle>
          <AlertDescription>Meta leads arrive in a different ProdigyFlo workspace, so this funnel can&apos;t match them.</AlertDescription>
        </Alert>
      )}
      {data.attributionBroken && (
        <Alert>
          <AlertTriangle className="text-warning" />
          <AlertTitle>Lead credit looks off</AlertTitle>
          <AlertDescription>
            One ad is getting credit for most leads in ProdigyFlo but not in Meta. Check that the lead form is only used by
            one ad.
          </AlertDescription>
        </Alert>
      )}

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon="Filter"
            title="No leads matched to ads in this period"
            description="Leads show up here once they arrive from a Meta lead form and are matched to the ad they came from."
          />
        </Card>
      ) : (
        <>
          <FunnelChart
            steps={steps(rows)}
            title="From lead to sale"
            description={`Leads from SCS General 1 ads · spend ${money(totals.spend)} · revenue ${money(totals.revenue)}`}
          />

          {/* Desktop: one wide table, scrolling inside its own frame. */}
          <div className="hidden rounded-lg border md:block">
            <Table className="min-w-[76rem] tabular-nums">
              <TableHeader>
                <TableRow>
                  <TableHead>Ad</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right"><Term tip={`${GLOSSARY.metaLeads} ${GLOSSARY.leads}`}>Meta leads</Term></TableHead>
                  <TableHead className="text-right"><Term tip={GLOSSARY.crmLeads}>CRM leads</Term></TableHead>
                  <TableHead className="text-right">Contacted</TableHead>
                  <TableHead className="text-right">Booked</TableHead>
                  <TableHead className="text-right">Showed</TableHead>
                  <TableHead className="text-right">Sold</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Per lead</TableHead>
                  <TableHead className="text-right">Per booking</TableHead>
                  <TableHead className="text-right">Per show</TableHead>
                  <TableHead className="text-right">Per sale</TableHead>
                  <TableHead className="text-right"><Term tip={GLOSSARY.roas}>ROAS</Term></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.adExternalId}>
                    <TableCell className="max-w-[20rem]">
                      <span className="block truncate font-medium">{r.adName}</span>
                      <span className="text-muted-foreground block truncate text-xs">{r.campaignName}</span>
                      {r.attributionDoubt && <span className="mt-1 block"><DoubtBadge /></span>}
                    </TableCell>
                    <TableCell className="text-right">{money(r.spend)}</TableCell>
                    <TableCell className="text-right">{count(r.metaLeads)}</TableCell>
                    <TableCell className="text-right">{count(r.leads)}</TableCell>
                    <TableCell className="text-right">{count(r.contacted)}</TableCell>
                    <TableCell className="text-right">{count(r.booked)}</TableCell>
                    <TableCell className="text-right">{count(r.sat)}</TableCell>
                    <TableCell className="text-right">{count(r.sold)}</TableCell>
                    <TableCell className="text-right">{money(r.revenue)}</TableCell>
                    <TableCell className="text-right">{unitCost(r.costPerLead)}</TableCell>
                    <TableCell className="text-right">{unitCost(r.costPerBooked)}</TableCell>
                    <TableCell className="text-right">{unitCost(r.costPerSat)}</TableCell>
                    <TableCell className="text-right">{unitCost(r.costPerSale)}</TableCell>
                    <TableCell className="text-right">{roasText(r.roas)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Phone: one card per ad. */}
          <ul className="space-y-3 md:hidden">
            {rows.map((r) => (
              <li key={r.adExternalId}>
                <Card size="sm" className="px-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{r.adName}</p>
                    <p className="text-muted-foreground truncate text-xs">{r.campaignName}</p>
                    {r.attributionDoubt && <div className="mt-1.5"><DoubtBadge /></div>}
                  </div>
                  <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-xs tabular-nums">
                    <div><dt className="text-muted-foreground">Spend</dt><dd className="text-sm font-medium">{money(r.spend)}</dd></div>
                    <div><dt className="text-muted-foreground">Meta leads</dt><dd className="text-sm font-medium">{count(r.metaLeads)}</dd></div>
                    <div><dt className="text-muted-foreground">CRM leads</dt><dd className="text-sm font-medium">{count(r.leads)}</dd></div>
                    <div><dt className="text-muted-foreground">Contacted</dt><dd>{count(r.contacted)}</dd></div>
                    <div><dt className="text-muted-foreground">Booked</dt><dd>{count(r.booked)}</dd></div>
                    <div><dt className="text-muted-foreground">Showed</dt><dd>{count(r.sat)}</dd></div>
                    <div><dt className="text-muted-foreground">Sold</dt><dd>{count(r.sold)}</dd></div>
                    <div><dt className="text-muted-foreground">Revenue</dt><dd>{money(r.revenue)}</dd></div>
                    <div><dt className="text-muted-foreground">ROAS</dt><dd>{roasText(r.roas)}</dd></div>
                    <div><dt className="text-muted-foreground">Per lead</dt><dd>{unitCost(r.costPerLead)}</dd></div>
                    <div><dt className="text-muted-foreground">Per booking</dt><dd>{unitCost(r.costPerBooked)}</dd></div>
                    <div><dt className="text-muted-foreground">Per sale</dt><dd>{unitCost(r.costPerSale)}</dd></div>
                  </dl>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="text-muted-foreground space-y-0.5 text-xs">
        <p>
          <Term tip="Includes leads from before ProdigyFlo started saving which ad a lead came from.">Not matched to an ad</Term>:{' '}
          {count(data.unmatched)}
        </p>
        <p>From ads outside SCS General 1 (hidden): {count(data.outside)}</p>
        <p>Still being checked: {count(data.pending)}</p>
      </div>
    </div>
  )
}
