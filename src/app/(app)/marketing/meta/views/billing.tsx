import { CreditCard, ExternalLink } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent } from '@/components/ui/card'
import { buttonVariants } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { dateTime } from '@/lib/format'
import type { BillingView } from '@/lib/meta/ads/read'
import { AccountCardView } from './overview'
import { money } from './parts'
import { SpendBars } from './spend-bars'

type LedgerRow = BillingView['ledger'][number]

function whatHappened(row: LedgerRow): string {
  if (row.kind === 'PAYMENT') {
    return row.amount === null ? 'Payment or charge' : `Payment or charge, about ${money(row.amount)}`
  }
  if (row.kind === 'STATUS_CHANGE') return `Status changed: ${row.before ?? 'unknown'} → ${row.after ?? 'unknown'}`
  return 'Card changed'
}

export function BillingViewSection({ data }: { data: BillingView }) {
  const tz = data.account.timezoneName ?? undefined

  return (
    <div className="space-y-4">
      <AccountCardView account={data.account} />

      <Card>
        <CardContent className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs">Unpaid balance</p>
            <p className="text-2xl font-semibold tracking-tight tabular-nums">{money(data.account.balance)}</p>
            <p className="text-muted-foreground mt-1 max-w-md text-xs">
              Meta charges the card when this reaches the billing threshold or on the billing date.
            </p>
            {data.pending && (
              <p className="text-warning mt-2 text-sm font-medium">
                Possible payment of about {money(data.pending.amount)}, confirming…
              </p>
            )}
          </div>
          <a
            href={data.account.billingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: 'outline', className: 'h-10 sm:h-8' })}
          >
            <CreditCard data-icon="inline-start" />
            Open billing in Meta
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </CardContent>
      </Card>

      <SpendBars title="Daily spend" description="Last 90 days" data={data.spend90} />

      <section>
        <h2 className="mb-2 text-sm font-semibold">Payments and changes</h2>
        {data.detector === 'off_funding' ? (
          <Alert>
            <AlertDescription>This account isn&apos;t paid by card, so payments aren&apos;t tracked here.</AlertDescription>
          </Alert>
        ) : data.ledger.length === 0 ? (
          <Card>
            <p className="text-muted-foreground px-4 text-sm">No payments or changes seen yet.</p>
          </Card>
        ) : (
          <div className="rounded-lg border">
            <Table className="tabular-nums">
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>What happened</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.ledger.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">{dateTime(row.at, tz)}</TableCell>
                    <TableCell className="whitespace-normal">{whatHappened(row)}</TableCell>
                    <TableCell className="text-right">
                      {row.amount === null ? '—' : `${row.approximate ? '~' : ''}${money(row.amount)}`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {data.detector === 'on' && (
          <p className="text-muted-foreground mt-2 text-xs">
            Worked out from balance drops. Amounts are a floor, times are within about 10 minutes, and a row can also be a
            manual payment, credit or refund.
          </p>
        )}
      </section>
    </div>
  )
}
