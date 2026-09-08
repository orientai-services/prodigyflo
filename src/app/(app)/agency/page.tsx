import Link from 'next/link'
import { redirect } from 'next/navigation'
import { CreditCard, Phone, UserRound, Users, Wallet } from 'lucide-react'
import { db } from '@/lib/db'
import { requirePermissionPage } from '@/lib/rbac'
import { shortDate } from '@/lib/format'
import { money } from '@/lib/telephony/pricing'
import { formatE164 } from '@/lib/telephony/provider'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { OrgMark, hasOrgMark } from '@/components/brand/org-brand'
import { Badge } from '@/components/ui/badge'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { NewAccountDialog } from './new-account-dialog'
import { OpenAccountButton } from './open-account-button'

export const metadata = { title: 'Agency accounts' }

/** Serialized card view — crosses the RSC boundary, so plain strings/numbers only. */
type AccountCardView = {
  id: string
  name: string
  slug: string
  clientCount: number
  userCount: number
  /** Preformatted — dates never cross the boundary raw. */
  createdOn: string
  /** The account's main line, or null when it has no number yet. */
  mainLine: string | null
  lineCount: number
  /** "$42.00 balance" or "agency card" — the funding story in one phrase. */
  fundingLabel: string
  onAgencyCard: boolean
}

const ORG_CARD_SELECT = {
  id: true,
  name: true,
  slug: true,
  createdAt: true,
  telephonyWallet: { select: { balanceCents: true, billingMode: true } },
  // Ordered in toView() rather than here: an `as const` select makes a tuple
  // orderBy readonly, which Prisma's mutable input type rejects.
  phoneNumbers: {
    where: { status: 'ACTIVE' as const },
    select: { e164: true, isPrimary: true },
  },
  _count: {
    select: {
      clients: { where: { deletedAt: null } },
      users: { where: { deletedAt: null } },
    },
  },
} as const

function toView(org: {
  id: string
  name: string
  slug: string
  createdAt: Date
  telephonyWallet: { balanceCents: number; billingMode: string } | null
  phoneNumbers: { e164: string; isPrimary: boolean }[]
  _count: { clients: number; users: number }
}): AccountCardView {
  const onAgencyCard = org.telephonyWallet?.billingMode === 'AGENCY_CARD'
  const main = org.phoneNumbers.find((n) => n.isPrimary) ?? org.phoneNumbers[0] ?? null
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    clientCount: org._count.clients,
    userCount: org._count.users,
    createdOn: shortDate(org.createdAt),
    mainLine: main ? formatE164(main.e164) : null,
    lineCount: org.phoneNumbers.length,
    fundingLabel: onAgencyCard
      ? 'On the agency card'
      : `${money(org.telephonyWallet?.balanceCents ?? 0)} balance`,
    onAgencyCard,
  }
}

function AccountCard({
  account,
  isHome,
  isActive,
}: {
  account: AccountCardView
  isHome: boolean
  isActive: boolean
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <OrgMark
            slug={account.slug}
            kind={isHome ? 'AGENCY' : 'CLIENT'}
            className={
              hasOrgMark(account.slug)
                ? 'size-4 shrink-0'
                : 'text-muted-foreground size-4 shrink-0'
            }
          />
          <span className="truncate">{account.name}</span>
        </CardTitle>
        <CardAction className="flex items-center gap-1.5">
          {isHome && <Badge variant="secondary">Home</Badge>}
          {isActive && <Badge>Current</Badge>}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono">/{account.slug}</Badge>
        </div>
        <div className="text-muted-foreground flex items-center gap-4 text-xs tabular-nums">
          <span className="flex items-center gap-1.5">
            <Users className="size-3.5" />
            {account.clientCount} {account.clientCount === 1 ? 'client' : 'clients'}
          </span>
          <span className="flex items-center gap-1.5">
            <UserRound className="size-3.5" />
            {account.userCount} {account.userCount === 1 ? 'user' : 'users'}
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 border-t pt-3 text-xs">
          <span className="flex min-w-0 items-center gap-1.5">
            <Phone className="text-muted-foreground size-3.5 shrink-0" />
            {account.mainLine ? (
              <span className="truncate font-mono tabular-nums">
                {account.mainLine}
                {account.lineCount > 1 && (
                  <span className="text-muted-foreground"> +{account.lineCount - 1}</span>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">No phone line</span>
            )}
          </span>
          <span className="text-muted-foreground flex shrink-0 items-center gap-1.5">
            {account.onAgencyCard ? <CreditCard className="size-3.5" /> : <Wallet className="size-3.5" />}
            {account.fundingLabel}
          </span>
        </div>
        <div className="flex items-center justify-between border-t pt-3">
          <span className="text-muted-foreground text-xs">Created {account.createdOn}</span>
          {isActive ? (
            // Phone numbers are scoped to the ACTIVE account, so the shortcut
            // only appears on the account you are actually inside.
            <Button variant="outline" size="sm" render={<Link href="/settings/phone-numbers" />}>
              <Phone data-slot="icon" />
              Phone numbers
            </Button>
          ) : (
            <OpenAccountButton orgId={account.id} />
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export default async function AgencyPage() {
  // Gate: users:manage AND the caller's HOME org is the agency. No dedicated
  // permission key on purpose — see the agency-model plan (seed-sync trap).
  const user = await requirePermissionPage('users:manage')
  if (user.organizationKind !== 'AGENCY') redirect('/forbidden')
  const homeOrganizationId = user.homeOrganizationId ?? user.organizationId

  const [home, children] = await Promise.all([
    db.organization.findFirst({
      where: { id: homeOrganizationId, deletedAt: null },
      select: ORG_CARD_SELECT,
    }),
    db.organization.findMany({
      where: { parentOrganizationId: homeOrganizationId, deletedAt: null },
      orderBy: { name: 'asc' },
      select: ORG_CARD_SELECT,
    }),
  ])
  if (!home) redirect('/forbidden')

  const homeView = toView(home)
  const childViews = children.map(toView)

  return (
    <div>
      <PageHeader
        title="Agency accounts"
        description="Every client account your agency runs. Open one to work inside it — the whole app scopes to the account you are in."
        actions={<NewAccountDialog />}
      />

      <div className="space-y-4 p-4 sm:p-6">
        <section>
          <h2 className="mb-3 text-sm font-semibold">Agency</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <AccountCard account={homeView} isHome isActive={user.organizationId === homeView.id} />
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold">
            Client accounts{' '}
            <span className="text-muted-foreground font-normal">· {childViews.length}</span>
          </h2>
          {childViews.length === 0 ? (
            <div className="rounded-lg border">
              <EmptyState
                icon="Building2"
                illustration="brand"
                title="No client accounts yet"
                description="Create your first client account and it comes ready to work: pipeline, roles, intake survey, and document package included."
                action={<NewAccountDialog />}
              />
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {childViews.map((account) => (
                <AccountCard
                  key={account.id}
                  account={account}
                  isHome={false}
                  isActive={user.organizationId === account.id}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
