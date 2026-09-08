import Link from 'next/link'
import { can, requirePermissionPage } from '@/lib/rbac'
import { relativeTime } from '@/lib/format'
import { listConnectorStatus } from '@/lib/connectors/provision'
import { displayState } from '@/lib/connectors/credential-logic'
import { isInbound } from '@/lib/connectors/catalog'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { ConnectorsGallery, type ConnectorCardVM } from './connectors-gallery'

export const metadata = { title: 'Connectors' }

export default async function ConnectorsPage() {
  const user = await requirePermissionPage('connectors:read')
  const canManage = can(user, 'connectors:manage')
  const instances = await listConnectorStatus(user)

  const cards: ConnectorCardVM[] = instances.map((i) => ({
    defId: i.def.id,
    name: i.def.name,
    tagline: i.def.tagline,
    category: i.def.category,
    direction: i.def.direction,
    availability: i.def.availability,
    glyph: i.def.glyph,
    accent: i.def.accent,
    state: displayState(i.state, i.mode),
    model: isInbound(i.def) ? ('intakeSource' as const) : ('connector' as const),
    instanceName: i.name,
    submissionCount: i.submissionCount ?? null,
    healthOk: i.health.ok,
    healthDetail: i.health.detail,
    lastLabel: i.health.lastAt ? relativeTime(i.health.lastAt) : null,
  }))

  return (
    <>
      <PageHeader
        title="Connectors"
        description="Connect the tools your leads flow through — CRMs, ad platforms, spreadsheets and webhooks — from one place."
        actions={
          <Button variant="outline" size="sm" render={<Link href="/settings/intake" />}>
            Intake sources
          </Button>
        }
      />
      <div className="px-4 py-5 sm:px-6">
        <ConnectorsGallery cards={cards} canManage={canManage} />
      </div>
    </>
  )
}
