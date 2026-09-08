'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Search } from 'lucide-react'
import { CONNECTOR_CATEGORIES } from '@/lib/connectors/catalog'
import type { ConnectorCategory, ConnectorDirection, ConnectorAvailability } from '@/lib/connectors/catalog'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/empty-state'
import type { ConnectorUiState } from '@/lib/connectors/credential-logic'
import { ConnectButton } from './connect-dialog'

export type ConnectorCardVM = {
  defId: string
  name: string
  tagline: string
  category: ConnectorCategory
  direction: ConnectorDirection
  availability: ConnectorAvailability
  glyph: string
  accent: string
  /** UI state — 'mock' split out of 'connected' so mock mode is never dressed up as live. */
  state: ConnectorUiState
  /** Which record backs this def — outbound Connectors take the credentials path, not the inbound dialog. */
  model: 'intakeSource' | 'connector'
  instanceName: string | null
  submissionCount: number | null
  healthOk: boolean
  healthDetail: string | null
  lastLabel: string | null
}

const STATE_PILL: Record<ConnectorUiState, { label: string; className: string }> = {
  available: { label: 'Available', className: 'text-muted-foreground border-border' },
  connected: { label: 'Connected', className: 'text-success border-success/30 bg-success/10' },
  mock: { label: 'Mock', className: 'text-warning border-warning/30 bg-warning/10' },
  disabled: { label: 'Disabled', className: 'text-muted-foreground border-border bg-muted' },
  error: { label: 'Error', className: 'text-danger border-danger/30 bg-danger/10' },
  'coming-soon': { label: 'Coming soon', className: 'text-muted-foreground border-dashed border-border' },
}

const DIRECTION_LABEL: Record<ConnectorDirection, string> = {
  inbound: 'Inbound',
  outbound: 'Outbound',
  bidirectional: 'Two-way',
}

function StatusPill({ state }: { state: ConnectorUiState }) {
  const s = STATE_PILL[state]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium ${s.className}`}
    >
      {(state === 'connected' || state === 'mock' || state === 'error') && (
        <span
          className={`size-1.5 rounded-full ${
            state === 'connected' ? 'bg-success' : state === 'mock' ? 'bg-warning' : 'bg-danger'
          }`}
        />
      )}
      {s.label}
    </span>
  )
}

function Glyph({ glyph, accent }: { glyph: string; accent: string }) {
  return (
    <span
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-lg text-lg"
      style={{ backgroundColor: `${accent}1f`, color: accent }}
    >
      {glyph}
    </span>
  )
}

function ConnectorCard({ card, canManage }: { card: ConnectorCardVM; canManage: boolean }) {
  const comingSoon = card.state === 'coming-soon'
  const provisioned =
    card.state === 'connected' || card.state === 'mock' || card.state === 'disabled' || card.state === 'error'
  const detailHref = `/settings/connectors/${card.defId}`

  return (
    <div
      className={`group bg-card flex flex-col rounded-xl border p-4 transition-colors ${
        comingSoon ? 'opacity-70' : 'hover:border-foreground/20'
      }`}
    >
      <div className="flex items-start gap-3">
        <Glyph glyph={card.glyph} accent={card.accent} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {provisioned ? (
              <Link href={detailHref} className="truncate text-sm font-semibold hover:underline">
                {card.name}
              </Link>
            ) : (
              <span className="truncate text-sm font-semibold">{card.name}</span>
            )}
          </div>
          <p className="text-muted-foreground mt-0.5 text-[0.6875rem] tracking-wide uppercase">
            {DIRECTION_LABEL[card.direction]} · {card.category}
          </p>
        </div>
        <StatusPill state={card.state} />
      </div>

      <p className="text-muted-foreground mt-3 line-clamp-2 text-sm">{card.tagline}</p>

      {provisioned && (
        <div className="text-muted-foreground mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {card.instanceName && <span className="text-foreground/80 truncate font-medium">{card.instanceName}</span>}
          {card.submissionCount != null && (
            <span className="tabular-nums">
              {card.submissionCount} {card.submissionCount === 1 ? 'submission' : 'submissions'}
            </span>
          )}
          {card.state === 'error' && card.healthDetail ? (
            <span className="text-danger truncate" title={card.healthDetail}>
              {card.healthDetail}
            </span>
          ) : card.lastLabel ? (
            <span>Last activity {card.lastLabel}</span>
          ) : null}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-2 pt-1">
        {comingSoon ? (
          <span className="text-muted-foreground text-xs">Available soon</span>
        ) : provisioned ? (
          <Link
            href={detailHref}
            className="text-foreground inline-flex items-center gap-1 text-xs font-medium hover:underline"
          >
            Manage
            <ArrowUpRight className="size-3.5" />
          </Link>
        ) : (
          <Link
            href={detailHref}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
          >
            Details
          </Link>
        )}

        {!comingSoon && !provisioned && canManage && card.model === 'intakeSource' && (
          <ConnectButton
            target={{ defId: card.defId, name: card.name, glyph: card.glyph, accent: card.accent }}
            size="xs"
          />
        )}
        {!comingSoon && !provisioned && canManage && card.model === 'connector' && (
          <Link
            href={detailHref}
            className="text-foreground inline-flex items-center gap-1 text-xs font-medium hover:underline"
          >
            Set up
            <ArrowUpRight className="size-3.5" />
          </Link>
        )}
      </div>
    </div>
  )
}

export function ConnectorsGallery({ cards, canManage }: { cards: ConnectorCardVM[]; canManage: boolean }) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return cards
    return cards.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.tagline.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q) ||
        (c.instanceName?.toLowerCase().includes(q) ?? false),
    )
  }, [cards, query])

  const grouped = useMemo(() => {
    const byCat = new Map<ConnectorCategory, ConnectorCardVM[]>()
    for (const c of filtered) {
      const list = byCat.get(c.category) ?? []
      list.push(c)
      byCat.set(c.category, list)
    }
    return CONNECTOR_CATEGORIES.map((cat) => ({ cat, items: byCat.get(cat) ?? [] })).filter((g) => g.items.length > 0)
  }, [filtered])

  const connectedCount = cards.filter((c) => c.state === 'connected').length

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative max-w-xs flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search connectors…"
            className="pl-8"
            aria-label="Search connectors"
          />
        </div>
        <p className="text-muted-foreground text-xs">
          {connectedCount} connected · {cards.length} available in catalog
        </p>
      </div>

      {grouped.length === 0 ? (
        <EmptyState
          icon="SearchX"
          title="No connectors match"
          description="Try a different name or category."
        />
      ) : (
        grouped.map(({ cat, items }) => (
          <section key={cat}>
            <h2 className="text-muted-foreground mb-3 text-xs font-semibold tracking-[0.06em] uppercase">{cat}</h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((card) => (
                <ConnectorCard key={card.defId} card={card} canManage={canManage} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
