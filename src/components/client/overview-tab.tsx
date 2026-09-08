import { CheckCircle2, CircleSlash, ShieldCheck } from 'lucide-react'
import { db } from '@/lib/db'
import { can, requireUser, requireClientInScope, userScope } from '@/lib/rbac'
import { currency, dateTime, humanize, shortDate } from '@/lib/format'
import { getAIProvider } from '@/lib/ai'
import { listAssistViews } from '@/lib/ai/assists'
import { OverviewForm } from '@/app/(app)/clients/[clientId]/overview-form'
import { AIPanel } from '@/app/(app)/clients/[clientId]/ai-panel'

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-right text-sm">{value ?? '—'}</dd>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-card rounded-lg border p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      <dl className="mt-2 divide-y">{children}</dl>
    </section>
  )
}

export async function OverviewTab({ clientId }: { clientId: string }) {
  const user = await requireUser()
  await requireClientInScope(user, clientId)

  const client = await db.client.findUniqueOrThrow({
    where: { id: clientId },
    include: {
      addresses: { orderBy: { isPrimary: 'desc' } },
      consents: { orderBy: { grantedAt: 'desc' } },
      verifications: true,
      owner: { select: { id: true, name: true } },
      team: { select: { name: true } },
      region: { select: { name: true } },
      leadSource: { select: { id: true, name: true } },
      campaign: { select: { name: true } },
    },
  })

  const canEdit = can(user, 'clients:update')
  const canReassign = can(user, 'clients:reassign')

  const [owners, leadSources] = canEdit
    ? await Promise.all([
        db.user.findMany({
          where: { ...userScope(user), isActive: true, role: { key: { notIn: ['CLIENT'] } } },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        db.leadSource.findMany({
          where: { organizationId: user.organizationId, isActive: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
      ])
    : [[], []]

  const primary = client.addresses.find((a) => a.isPrimary) ?? client.addresses[0]
  const activeConsents = client.consents.filter((c) => c.granted && !c.revokedAt)

  const canRunAI = can(user, 'ai:run')
  const canReviewAI = can(user, 'ai:review')
  const assistItems = canRunAI || canReviewAI ? await listAssistViews(user, client.id) : []
  const aiProvider = getAIProvider()

  return (
    <div className="space-y-4">
      {(canRunAI || canReviewAI) && (
        <AIPanel
          clientId={client.id}
          canRun={canRunAI}
          canReview={canReviewAI}
          mock={aiProvider.name === 'mock'}
          modelLabel={aiProvider.model}
          items={assistItems}
        />
      )}

      {canEdit && (
        <OverviewForm
          clientId={client.id}
          initial={{
            firstName: client.firstName,
            lastName: client.lastName,
            email: client.email,
            phone: client.phone,
            preferredLanguage: client.preferredLanguage,
            preferredContact: client.preferredContact,
            estimatedValue: client.estimatedValue?.toString() ?? '',
            ownerId: client.ownerId ?? '',
            leadSourceId: client.leadSourceId ?? '',
            line1: primary?.line1 ?? '',
            line2: primary?.line2 ?? '',
            city: primary?.city ?? '',
            state: primary?.state ?? '',
            postalCode: primary?.postalCode ?? '',
          }}
          owners={owners.map((o) => ({ value: o.id, label: o.name }))}
          leadSources={leadSources.map((s) => ({ value: s.id, label: s.name }))}
          canReassign={canReassign}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Contact">
          <Row label="Name" value={`${client.firstName} ${client.lastName}`} />
          <Row label="Email" value={client.email} />
          <Row label="Phone" value={client.phone} />
          <Row label="Preferred language" value={client.preferredLanguage === 'es' ? 'Spanish' : 'English'} />
          <Row label="Preferred contact" value={humanize(client.preferredContact)} />
          <Row
            label="Address"
            value={
              primary
                ? `${primary.line1}${primary.line2 ? `, ${primary.line2}` : ''}, ${primary.city}, ${primary.state} ${primary.postalCode}`
                : '—'
            }
          />
        </Section>

        <Section title="Deal">
          <Row label="Estimated value" value={currency(client.estimatedValue)} />
          <Row label="Probability" value={client.probability != null ? `${client.probability}%` : '—'} />
          <Row label="Expected close" value={shortDate(client.expectedCloseAt)} />
          <Row label="Created" value={shortDate(client.createdAt)} />
          <Row label="First contact" value={shortDate(client.firstContactAt)} />
          {client.lostReason && <Row label="Lost reason" value={client.lostReason} />}
          {client.holdReason && <Row label="Hold reason" value={client.holdReason} />}
          {client.disqualifiedReason && <Row label="Disqualified" value={client.disqualifiedReason} />}
        </Section>

        <Section title="Ownership & team">
          <Row label="Owner" value={client.owner?.name ?? 'Unassigned'} />
          <Row label="Team" value={client.team?.name ?? '—'} />
          <Row label="Region" value={client.region?.name ?? '—'} />
        </Section>

        <Section title="Source & attribution">
          <Row label="Lead source" value={client.leadSource?.name ?? '—'} />
          <Row label="Campaign" value={client.campaign?.name ?? '—'} />
          <Row label="UTM source" value={client.utmSource ?? '—'} />
          <Row label="UTM medium" value={client.utmMedium ?? '—'} />
          <Row label="UTM campaign" value={client.utmCampaign ?? '—'} />
        </Section>

        <section className="bg-card rounded-lg border p-4 lg:col-span-2">
          <h3 className="flex items-center gap-1.5 text-sm font-medium">
            <ShieldCheck className="size-4" />
            Consents & verification
          </h3>
          {activeConsents.length === 0 ? (
            <p className="text-muted-foreground mt-2 text-xs">No active consents on file.</p>
          ) : (
            <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {activeConsents.map((c) => (
                <li key={c.id} className="flex items-center gap-2 text-xs">
                  <CheckCircle2 className="text-success size-3.5 shrink-0" />
                  <span>
                    {humanize(c.type)}
                    <span className="text-muted-foreground"> · v{c.textVersion} · {dateTime(c.grantedAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {client.verifications.length > 0 && (
            <ul className="text-muted-foreground mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t pt-2 text-xs">
              {client.verifications.map((v) => (
                <li key={v.id} className="inline-flex items-center gap-1">
                  {v.status === 'VERIFIED' ? (
                    <CheckCircle2 className="text-success size-3" />
                  ) : (
                    <CircleSlash className="size-3" />
                  )}
                  {humanize(v.type)}: {humanize(v.status).toLowerCase()}
                  {v.maskedValue ? ` (${v.maskedValue})` : ''}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
