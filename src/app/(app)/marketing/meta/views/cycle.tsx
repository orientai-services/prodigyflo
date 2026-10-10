import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/empty-state'
import { Progress } from '@/components/ui/progress'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import type { CycleView } from '@/lib/meta/ads/read'
import { CycleLengthForm, StartCycleButton } from '../meta-islands'
import { Fact, GLOSSARY, Term, count, money, unitCost } from './parts'

/** A calendar date in the ad account's own time zone, e.g. "Oct 8, 2026". */
function accountDate(d: Date | null, timeZone: string | null): string {
  if (!d) return '—'
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  })
}

/** "about" before a spend figure whose start day couldn't be split by hour. */
function About() {
  return (
    <Term tip="Spend on the start day was split by hour and Meta didn't return the hours, so this is close but not exact." className="text-muted-foreground mr-1 font-normal">
      about
    </Term>
  )
}

export function CycleViewSection({
  data, canManage, timeZone,
}: { data: CycleView; canManage: boolean; timeZone: string | null }) {
  const c = data.current
  const now = new Date()

  return (
    <div className="space-y-4">
      {c ? (
        <Card>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-base font-semibold">
                  Cycle {c.number} · day {Math.min(c.day, c.lengthDays)} of {c.lengthDays}
                </h2>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {accountDate(c.startedAt, timeZone)} to {accountDate(c.endsAt, timeZone)}
                  {timeZone ? ` · ${timeZone.replace(/_/g, ' ')} time` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {c.overdue && (
                  <Badge variant="outline" className="text-warning border-warning/40">
                    Overdue · day {c.day}
                  </Badge>
                )}
                {canManage && <StartCycleButton current={{ number: c.number, spendText: money(c.spend) }} />}
              </div>
            </div>
            <Progress value={Math.min(100, (c.day / Math.max(1, c.lengthDays)) * 100)} aria-label={`Day ${c.day} of ${c.lengthDays}`} />
            <dl className="grid grid-cols-3 gap-4">
              <Fact label="Spend">
                {c.approximate && <About />}
                {money(c.spend)}
              </Fact>
              <Fact label={<Term tip={GLOSSARY.leads}>Leads</Term>}>{count(c.leads)}</Fact>
              <Fact label={<Term tip={GLOSSARY.cpl}>Cost per lead</Term>}>{unitCost(c.cpl)}</Fact>
            </dl>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <EmptyState
            icon="CalendarRange"
            title="No cycle started yet"
            description="A cycle tracks spend and leads over a fixed number of days, so each stretch can be compared with the last."
            action={canManage ? <StartCycleButton current={null} /> : undefined}
          />
        </Card>
      )}

      {canManage && (
        <Card>
          <CardContent className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0 max-w-md">
              <p className="text-sm font-medium">Cycle length</p>
              <p className="text-muted-foreground mt-0.5 text-xs">Applies to the cycle running now and every cycle after it.</p>
            </div>
            <CycleLengthForm days={data.lengthDays} />
          </CardContent>
        </Card>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold">Past cycles</h2>
        {data.history.length === 0 ? (
          <Card>
            <p className="text-muted-foreground px-4 text-sm">No finished cycles yet.</p>
          </Card>
        ) : (
          <div className="rounded-lg border">
            <Table className="tabular-nums">
              <TableHeader>
                <TableRow>
                  <TableHead>Cycle</TableHead>
                  <TableHead>Dates</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="text-right">Per lead</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.history.map((h) => {
                  const settling = !h.final && h.finalAfter !== null && h.finalAfter > now
                  const cpl = h.spend !== null && h.leads ? h.spend / h.leads : null
                  return (
                    <TableRow key={h.number}>
                      <TableCell className="font-medium">
                        {h.number}
                        {settling && (
                          <span className="text-muted-foreground block text-xs font-normal">
                            <Term tip="Meta can still adjust spend for a few days after a cycle ends. These numbers update until then.">
                              final after {accountDate(h.finalAfter, timeZone)}
                            </Term>
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        {accountDate(h.startedAt, timeZone)} to {accountDate(h.endedAt, timeZone)}
                      </TableCell>
                      <TableCell className="text-right">
                        {h.spend === null ? 'Working it out' : (
                          <>
                            {h.approximate && <About />}
                            {money(h.spend)}
                          </>
                        )}
                      </TableCell>
                      <TableCell className="text-right">{count(h.leads)}</TableCell>
                      <TableCell className="text-right">{unitCost(cpl)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  )
}
