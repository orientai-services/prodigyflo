import { db } from '@/lib/db'
import { can, requireClientInScope, requireUser } from '@/lib/rbac'
import { getAIProvider } from '@/lib/ai'
import { listBriefViews } from '@/lib/ai/closeops-ai'
import { CloseProbabilityChip } from './close-probability-chip'
import { CloserBriefPanel } from './closer-brief-panel'

/**
 * Slim strip under the record header: the AI close-probability chip and its
 * standing disclaimer. Server component — reads the stored score only.
 */
export async function CloseOpsStrip({ clientId }: { clientId: string }) {
  const user = await requireUser()
  await requireClientInScope(user, clientId)

  // Staff prioritization signal — same visibility gate as the AI panel, so
  // portal clients and AI-less roles never see it.
  if (!can(user, 'ai:run') && !can(user, 'ai:review')) return null

  const client = await db.client.findUniqueOrThrow({
    where: { id: clientId },
    select: { aiCloseProbability: true, aiCloseProbabilityAt: true },
  })
  const provider = getAIProvider()

  return (
    <div className="bg-surface-sunk/30 flex flex-wrap items-center gap-2 border-b px-4 py-2 sm:px-6">
      <CloseProbabilityChip
        clientId={clientId}
        probability={client.aiCloseProbability}
        scoredAt={client.aiCloseProbabilityAt?.toISOString() ?? null}
        canRun={can(user, 'ai:run')}
        mock={provider.name === 'mock'}
      />
      <p className="text-muted-foreground text-[0.6875rem]">
        AI signal — prioritizes the call queue; humans decide qualification and the close.
      </p>
    </div>
  )
}

/** The Closer Brief card for the overview tab: latest brief + history. */
export async function CloserBriefSection({ clientId }: { clientId: string }) {
  const user = await requireUser()
  await requireClientInScope(user, clientId)

  if (!can(user, 'ai:run') && !can(user, 'ai:review')) return null

  const briefs = await listBriefViews(user, clientId)
  const provider = getAIProvider()

  return (
    <CloserBriefPanel
      clientId={clientId}
      canRun={can(user, 'ai:run')}
      mock={provider.name === 'mock'}
      modelLabel={provider.model}
      briefs={briefs}
    />
  )
}
