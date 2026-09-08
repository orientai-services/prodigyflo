import { PhoneCall, Voicemail } from 'lucide-react'
import { db } from '@/lib/db'
import { can, requirePermissionPage } from '@/lib/rbac'
import { relativeTime, shortDate } from '@/lib/format'
import { isMockTelephony, telephonyCredentials } from '@/lib/telephony'
import { listNumbers } from '@/lib/telephony/numbers'
import { ensureWallet, recentLedger } from '@/lib/telephony/billing'
import { agencyPassphraseStatus } from '@/lib/telephony/passphrase'
import { money, quoteNumber } from '@/lib/telephony/pricing'
import { formatE164 } from '@/lib/telephony/provider'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { NumbersConsole } from './numbers-console'
import type { ConsoleVM, LedgerRowVM, NumberVM, QuoteVM } from './types'
import type { PhoneNumberKind } from '@prisma/client'

export const metadata = { title: 'Phone numbers' }

/**
 * The account's phone lines: what it owns, who answers them, what they cost,
 * and how to get another one.
 *
 * Everything crossing into the client component is a plain, preformatted
 * view-model — no Dates, no Decimals, no Prisma rows — so the console renders
 * identical money and dates on both sides of the boundary.
 */
export default async function PhoneNumbersPage() {
  const user = await requirePermissionPage('telephony:read')
  const canManage = can(user, 'telephony:manage')

  const [wallet, numbers, ledger, members, credentials, passphrase] = await Promise.all([
    ensureWallet(user.organizationId),
    listNumbers(user.organizationId),
    recentLedger(user.organizationId, 12),
    db.user.findMany({
      where: { organizationId: user.organizationId, isActive: true, deletedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, phone: true },
    }),
    telephonyCredentials(user.organizationId),
    // The passphrase belongs to the AGENCY, not to whichever account is active.
    agencyPassphraseStatus(user.homeOrganizationId ?? user.organizationId),
  ])

  const mock = isMockTelephony()
  const numberVMs: NumberVM[] = numbers.map((n) => ({
    id: n.id,
    e164: n.e164,
    display: formatE164(n.e164),
    friendlyName: n.friendlyName,
    kind: n.kind,
    status: n.status,
    isPrimary: n.isPrimary,
    place: [n.locality, n.region].filter(Boolean).join(', ') || null,
    routing: n.routing,
    forwardTo: n.forwardTo,
    forwardToDisplay: n.forwardTo ? formatE164(n.forwardTo) : null,
    teamUserIds: Array.isArray(n.teamUserIds)
      ? (n.teamUserIds as unknown[]).filter((v): v is string => typeof v === 'string')
      : [],
    voicemailGreeting: n.voicemailGreeting,
    recordCalls: n.recordCalls,
    assignedUserId: n.assignedUserId,
    assignedUserName: n.assignedUser?.name ?? null,
    monthlyLabel: money(n.monthlyCostCents),
    renewsLabel: n.nextRenewalAt ? shortDate(n.nextRenewalAt) : null,
    provider: n.provider,
  }))

  const ledgerVMs: LedgerRowVM[] = ledger.map((row) => ({
    id: row.id,
    kind: row.kind,
    amountLabel: `${row.amountCents >= 0 ? '+' : '−'}${money(Math.abs(row.amountCents))}`,
    isCredit: row.amountCents >= 0,
    balanceLabel: money(row.balanceAfterCents),
    description: row.description,
    when: relativeTime(row.createdAt),
    numberDisplay: row.numberE164 ? formatE164(row.numberE164) : null,
    actorName: row.actorName,
  }))

  const monthlyTotalCents = numbers
    .filter((n) => n.status === 'ACTIVE')
    .reduce((sum, n) => sum + n.monthlyCostCents, 0)

  const vm: ConsoleVM = {
    organizationId: user.organizationId,
    organizationName: user.organizationName,
    canManage,
    isAgencyOperator: user.organizationKind === 'AGENCY',
    mockCarrier: mock,
    carrierConfigured: mock || credentials !== null,
    billingMode: wallet.billingMode,
    balanceLabel: money(wallet.balanceCents),
    balanceCents: wallet.balanceCents,
    agencyChargedLabel: money(wallet.agencyChargedCents),
    monthlyTotalLabel: money(monthlyTotalCents),
    passphraseConfigured: passphrase.configured,
    passphraseSource: passphrase.source,
    isOwner: user.isOwner,
    pricing: {
      LOCAL: quoteVM('LOCAL'),
      TOLL_FREE: quoteVM('TOLL_FREE'),
    },
    numbers: numberVMs,
    ledger: ledgerVMs,
    members: members.map((m) => ({ id: m.id, name: m.name, hasPhone: Boolean(m.phone) })),
  }

  const primary = numberVMs.find((n) => n.isPrimary && n.status === 'ACTIVE')

  return (
    <>
      <PageHeader
        title="Phone numbers"
        description={`The lines clients call and text ${user.organizationName} on. Each one rings whoever you choose and writes every call to the client's timeline.`}
      >
        {primary && (
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className="flex items-center gap-2">
              <PhoneCall className="text-muted-foreground size-4" />
              <span className="text-muted-foreground">Main line</span>
              <span className="font-mono font-medium tabular-nums">{primary.display}</span>
            </span>
            <span className="text-muted-foreground flex items-center gap-2">
              <Voicemail className="size-4" />
              {routingSummary(primary)}
            </span>
          </div>
        )}
      </PageHeader>

      <div className="px-4 py-5 sm:px-6">
        {numberVMs.length === 0 && !canManage ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">No phone line yet</CardTitle>
              <CardDescription>
                This account has no number of its own, so calls and texts have nowhere to land.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EmptyState
                icon="Phone"
                illustration="brand"
                title="Ask an admin to add a line"
                description="Anyone with permission to manage phone numbers can get one in under a minute."
              />
            </CardContent>
          </Card>
        ) : (
          <NumbersConsole vm={vm} />
        )}
      </div>
    </>
  )
}

/** One price, formatted once on the server so both sides read the same. */
function quoteVM(kind: PhoneNumberKind): QuoteVM {
  const q = quoteNumber(kind)
  return {
    monthlyLabel: money(q.monthlyCents),
    dueTodayLabel: money(q.dueTodayCents),
    dueTodayCents: q.dueTodayCents,
  }
}

function routingSummary(n: NumberVM): string {
  if (n.routing === 'FORWARD') return `Rings ${n.forwardToDisplay ?? 'a forwarding number'}`
  if (n.routing === 'TEAM') return `Rings ${n.teamUserIds.length} teammate${n.teamUserIds.length === 1 ? '' : 's'}`
  return 'Takes a voicemail'
}
