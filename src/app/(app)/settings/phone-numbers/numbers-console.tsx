'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  CreditCard,
  Loader2,
  MoreHorizontal,
  Phone,
  ShieldCheck,
  Star,
  Trash2,
  Wallet,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/components/empty-state'
import { cn } from '@/lib/utils'
import { releaseNumberAction, setPrimaryNumberAction } from './actions'
import { BuyNumberDialog } from './buy-number-dialog'
import { FundsDialog } from './funds-dialog'
import { PassphraseCard } from './passphrase-card'
import { RoutingDialog } from './routing-dialog'
import type { ConsoleVM, NumberVM } from './types'

/**
 * The phone-numbers console: the balance, the lines, and what each one costs.
 *
 * Every destructive or spending action is a dialog with the consequence
 * written out, and the two things a reader must not confuse — a prepaid
 * balance versus the agency card — are labelled differently everywhere they
 * appear rather than sharing a generic "billing" word.
 */
export function NumbersConsole({ vm }: { vm: ConsoleVM }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [editing, setEditing] = useState<NumberVM | null>(null)
  const [releasing, setReleasing] = useState<NumberVM | null>(null)

  const onAgencyCard = vm.billingMode === 'AGENCY_CARD'
  const active = vm.numbers.filter((n) => n.status === 'ACTIVE')
  const suspended = vm.numbers.filter((n) => n.status === 'SUSPENDED')

  const makePrimary = (n: NumberVM) => {
    startTransition(async () => {
      const res = await setPrimaryNumberAction(n.id)
      if (res.ok) {
        toast.success(`${n.display} is now the main line.`)
        router.refresh()
      } else {
        toast.error(res.error)
      }
    })
  }

  const confirmRelease = () => {
    if (!releasing) return
    const target = releasing
    startTransition(async () => {
      const res = await releaseNumberAction(target.id)
      setReleasing(null)
      if (res.ok) {
        toast.success(`${target.display} was released.`)
        router.refresh()
      } else {
        toast.error(res.error)
      }
    })
  }

  return (
    <div className="space-y-4">
      {!vm.carrierConfigured && (
        <p className="border-warning/40 bg-warning/10 text-warning flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <span>
            No carrier is connected for this account. Add the Twilio Account SID and Auth Token under Settings →
            Connectors → Twilio SMS, and numbers can be bought from here immediately.
          </span>
        </p>
      )}

      {/* ── Balance ── */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {onAgencyCard ? <CreditCard className="size-4" /> : <Wallet className="size-4" />}
              {onAgencyCard ? 'Billed to the agency card' : 'Phone balance'}
            </CardTitle>
            <CardDescription>
              {onAgencyCard
                ? 'This is an internal account, so its lines go on the agency card. Buying one still needs the agency provisioning passphrase.'
                : 'Numbers are bought and renewed from this balance. Run it dry and lines are suspended, never given away.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-3xl font-semibold tracking-tight tabular-nums">
                {onAgencyCard ? vm.agencyChargedLabel : vm.balanceLabel}
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                {onAgencyCard
                  ? 'charged to the agency card, all time'
                  : `available · ${vm.monthlyTotalLabel} a month across ${active.length} line${active.length === 1 ? '' : 's'}`}
              </p>
            </div>
            {!onAgencyCard && <FundsDialog vm={vm} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Monthly cost</CardTitle>
            <CardDescription>Across every active line on this account.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tracking-tight tabular-nums">{vm.monthlyTotalLabel}</p>
            <p className="text-muted-foreground mt-1 text-xs">
              {active.length} active{suspended.length > 0 ? ` · ${suspended.length} suspended` : ''}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Lines ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lines</CardTitle>
          <CardDescription>
            Clients call and text these. The main line is what outbound texts come from.
          </CardDescription>
          {vm.canManage && (
            <CardAction>
              <BuyNumberDialog vm={vm} />
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="px-0">
          {vm.numbers.length === 0 ? (
            <EmptyState
              icon="Phone"
              illustration="brand"
              title="No lines yet"
              description={`Give ${vm.organizationName} a number and every call and text lands on the right client automatically.`}
              action={vm.canManage ? <BuyNumberDialog vm={vm} /> : undefined}
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Label</TableHead>
                    <TableHead>Answers with</TableHead>
                    <TableHead className="text-right">Monthly</TableHead>
                    <TableHead>Status</TableHead>
                    {vm.canManage && <TableHead className="w-10" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {vm.numbers.map((n) => (
                    <TableRow key={n.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-medium tabular-nums">{n.display}</span>
                          {n.isPrimary && n.status === 'ACTIVE' && (
                            <Badge variant="secondary" className="gap-1">
                              <Star className="size-3" />
                              Main
                            </Badge>
                          )}
                        </div>
                        {n.place && <p className="text-muted-foreground mt-0.5 text-xs">{n.place}</p>}
                      </TableCell>
                      <TableCell className="max-w-48 truncate">{n.friendlyName}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">{answersWith(n)}</TableCell>
                      <TableCell className="text-right tabular-nums">{n.monthlyLabel}</TableCell>
                      <TableCell>
                        <StatusBadge n={n} />
                        {n.status === 'ACTIVE' && n.renewsLabel && (
                          <p className="text-muted-foreground mt-0.5 text-xs">renews {n.renewsLabel}</p>
                        )}
                      </TableCell>
                      {vm.canManage && (
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${n.display}`}>
                                  {pending ? (
                                    <Loader2 className="size-4 animate-spin" />
                                  ) : (
                                    <MoreHorizontal className="size-4" />
                                  )}
                                </Button>
                              }
                            />
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setEditing(n)}>Call handling…</DropdownMenuItem>
                              {!n.isPrimary && n.status === 'ACTIVE' && (
                                <DropdownMenuItem onClick={() => makePrimary(n)}>
                                  Make this the main line
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem variant="destructive" onClick={() => setReleasing(n)}>
                                Release the number…
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Ledger ── */}
      {vm.ledger.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Phone charges</CardTitle>
            <CardDescription>
              {onAgencyCard
                ? 'Everything this account has put on the agency card.'
                : 'Every movement on the balance, newest first.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <ul className="divide-y">
              {vm.ledger.map((row) => (
                <li key={row.id} className="flex items-start justify-between gap-4 px-6 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{row.description}</p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {row.when}
                      {row.actorName && ` · ${row.actorName}`}
                    </p>
                  </div>
                  <div className="text-right">
                    <p
                      className={cn(
                        'text-sm font-medium tabular-nums',
                        row.isCredit ? 'text-success' : 'text-foreground',
                      )}
                    >
                      {row.amountLabel}
                    </p>
                    {!onAgencyCard && (
                      <p className="text-muted-foreground text-xs tabular-nums">{row.balanceLabel}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* The owner's control over the agency-card gate. Nobody else sees it. */}
      {vm.isOwner && onAgencyCard && <PassphraseCard vm={vm} />}

      <RoutingDialog
        number={editing}
        members={vm.members}
        open={editing !== null}
        onOpenChange={(v) => !v && setEditing(null)}
      />

      {/* ── Release confirm ── */}
      <Dialog open={releasing !== null} onOpenChange={(v) => !v && setReleasing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Release {releasing?.display}?</DialogTitle>
            <DialogDescription>
              The number goes back to the carrier immediately and anyone can buy it next. Calls and texts to it stop,
              and it cannot be recovered — not even by buying again. Billing stops now; the current month is not
              refunded.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setReleasing(null)} disabled={pending}>
              Keep the number
            </Button>
            <Button variant="destructive" size="sm" onClick={confirmRelease} disabled={pending}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              Release it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function answersWith(n: NumberVM): string {
  if (n.routing === 'FORWARD') return n.forwardToDisplay ? `Rings ${n.forwardToDisplay}` : 'Forwarding (not set)'
  if (n.routing === 'TEAM') {
    return n.teamUserIds.length > 0
      ? `Rings ${n.teamUserIds.length} teammate${n.teamUserIds.length === 1 ? '' : 's'}`
      : 'Team ringing (nobody chosen)'
  }
  return 'Voicemail'
}

function StatusBadge({ n }: { n: NumberVM }) {
  if (n.status === 'ACTIVE') {
    return (
      <Badge variant="outline" className="gap-1">
        <Phone className="size-3" />
        Active
      </Badge>
    )
  }
  if (n.status === 'SUSPENDED') return <Badge variant="destructive">Suspended</Badge>
  if (n.status === 'PENDING') return <Badge variant="secondary">Setting up</Badge>
  return <Badge variant="ghost">Released</Badge>
}
