import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Info } from 'lucide-react'
import { can, requirePermissionPage } from '@/lib/rbac'
import { db } from '@/lib/db'
import { relativeTime } from '@/lib/format'
import { connectorDef, isInbound } from '@/lib/connectors/catalog'
import { listConnectorStatus } from '@/lib/connectors/provision'
import { buildCredentialFieldVMs, displayState } from '@/lib/connectors/credential-logic'
import { parseGhlImportState, zeroCounts } from '@/lib/connectors/ghl'
import { telephonyCredentials } from '@/lib/telephony'
import { PageHeader } from '@/components/page-header'
import { StepUpGate } from '@/components/stepup/stepup-gate'
import { ConnectorDetail, type ConnectorDetailVM } from './connector-detail'
import { CredentialsCard, type CredentialsCardVM } from './credentials-card'
import { GhlImportCard, type GhlImportCardVM } from './ghl-import-card'

export async function generateMetadata({ params }: PageProps<'/settings/connectors/[defId]'>) {
  const { defId } = await params
  const def = connectorDef(defId)
  return { title: def ? def.name : 'Connector' }
}

export default async function ConnectorDetailPage({ params }: PageProps<'/settings/connectors/[defId]'>) {
  const { defId } = await params
  const def = connectorDef(defId)
  if (!def) notFound()

  const user = await requirePermissionPage('connectors:read')
  const canManage = can(user, 'connectors:manage')

  const instances = await listConnectorStatus(user)
  const instance = instances.find((i) => i.def.id === def.id)
  if (!instance) notFound()

  // For a provisioned inbound connector, pull its live mapping + slug (org-scoped).
  const source =
    instance.instanceId && isInbound(def)
      ? await db.intakeSource.findFirst({
          where: { id: instance.instanceId, organizationId: user.organizationId },
          select: { id: true, slug: true, isEnabled: true, fieldMapping: true },
        })
      : null

  const initialMapping: Record<string, string> = source
    ? ((source.fieldMapping ?? {}) as Record<string, string>)
    : ((def.fieldPreset ?? {}) as Record<string, string>)

  // Outbound defs with credential fields: load MASKED vault rows (fieldKey +
  // last4 only — ciphertext and plaintext never leave the server, and only the
  // masked form may enter a VM). The card itself sits behind <StepUpGate>.
  let credentialsVM: CredentialsCardVM | null = null
  let ghlImportVM: GhlImportCardVM | null = null
  if (def.backing.model === 'connector' && def.credentialFields?.length && canManage) {
    const connector = await db.connector.findUnique({
      where: { organizationId_kind: { organizationId: user.organizationId, kind: def.backing.kind } },
      select: {
        id: true,
        status: true,
        config: true,
        lastError: true,
        credentials: { select: { fieldKey: true, last4: true, updatedAt: true } },
      },
    })

    // The GoHighLevel API def additionally carries the pull-import card: creds
    // readiness, the persisted resume state (phase + counts only — never
    // credential material), and when the last batch ran.
    if (def.id === 'gohighlevel-api') {
      const storedKeys = new Set((connector?.credentials ?? []).map((c) => c.fieldKey))
      const importState = parseGhlImportState(connector?.config)
      const lastLog = connector
        ? await db.connectorLog.findFirst({
            where: { connectorId: connector.id, event: { startsWith: 'ghl_import' } },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          })
        : null
      ghlImportVM = {
        credsReady: storedKeys.has('apiToken') && storedKeys.has('locationId'),
        phase: importState?.phase ?? 'idle',
        contacts: importState?.contacts ?? zeroCounts(),
        opportunities: importState?.opportunities ?? zeroCounts(),
        lastRunLabel: lastLog ? relativeTime(lastLog.createdAt) : null,
        lastError: connector?.lastError ?? null,
      }
    }

    credentialsVM = {
      defId: def.id,
      name: def.name,
      staged: def.availability === 'coming-soon',
      live: connector?.status === 'CONNECTED',
      fields: buildCredentialFieldVMs(
        def.credentialFields,
        (connector?.credentials ?? []).map((c) => ({
          fieldKey: c.fieldKey,
          last4: c.last4,
          updatedLabel: relativeTime(c.updatedAt),
        })),
      ),
    }
  }

  const vm: ConnectorDetailVM = {
    defId: def.id,
    name: def.name,
    tagline: def.tagline,
    glyph: def.glyph,
    accent: def.accent,
    category: def.category,
    direction: def.direction,
    availability: def.availability,
    setup: def.setup,
    docsUrl: def.docsUrl ?? null,
    inbound: isInbound(def),
    state: displayState(instance.state, instance.mode),
    instanceId: instance.instanceId,
    instanceName: instance.name,
    model: isInbound(def) ? 'intakeSource' : 'connector',
    isEnabled: source ? source.isEnabled : instance.state !== 'disabled',
    slug: source?.slug ?? null,
    webhookPath: source ? `/api/intake/${source.slug}` : null,
    intakeConfigHref: source ? `/settings/intake/${source.id}` : null,
    submissionCount: instance.submissionCount ?? null,
    healthOk: instance.health.ok,
    healthDetail: instance.health.detail,
    lastLabel: instance.health.lastAt ? relativeTime(instance.health.lastAt) : null,
    initialMapping,
    samplePayload: def.samplePayload ? JSON.stringify(def.samplePayload, null, 2) : '',
  }

  // A client account under an agency runs on the agency's Twilio account unless
  // it has pasted its own. Say so here, or this page reads "not configured"
  // while the phone-numbers console correctly reports a live carrier.
  let inheritsCarrier = false
  if (def.id === 'twilio-sms') {
    const ownCredentials = await db.connectorCredential.count({
      where: { organizationId: user.organizationId, connector: { kind: 'TWILIO_SMS' } },
    })
    inheritsCarrier = ownCredentials === 0 && (await telephonyCredentials(user.organizationId)) !== null
  }

  return (
    <>
      <PageHeader title={def.name} description={def.tagline}>
        <Link
          href="/settings/connectors"
          className="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-1 text-xs"
        >
          <ArrowLeft className="size-3.5" />
          All connectors
        </Link>
      </PageHeader>
      <div className="space-y-4 px-4 py-5 sm:px-6">
        {inheritsCarrier && (
          <p className="border-success/40 bg-success/10 text-success flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
            <Info className="mt-0.5 size-4 shrink-0" />
            <span>
              This account already sends on your agency&apos;s Twilio account — there is nothing to paste here.
              Store credentials below only to move it onto a carrier account of its own.
            </span>
          </p>
        )}
        <ConnectorDetail
          vm={vm}
          canManage={canManage}
          credentialsSlot={
            credentialsVM ? (
              <StepUpGate scope="vault">
                <CredentialsCard vm={credentialsVM} />
              </StepUpGate>
            ) : undefined
          }
          importSlot={ghlImportVM ? <GhlImportCard vm={ghlImportVM} /> : undefined}
        />
      </div>
    </>
  )
}
