'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { GripVertical, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { SlaIndicator } from '@/components/sla-indicator'
import { NativeSelect } from '@/components/ui/native-select'
import { currency, initials } from '@/lib/format'
import { cn } from '@/lib/utils'
import { moveCardAction } from './actions'

export type BoardLane = {
  key: string
  name: string
  categoryLabel: string
  /** Tailwind class for the category dot — computed server-side. */
  dotClass: string
  slaHours: number | null
  /** Stage keys a card in this lane may move to. */
  allowedNext: string[]
}

export type BoardCard = {
  id: string
  name: string
  value: number | null
  ownerName: string | null
  stageKey: string
  stageEnteredAt: string
  slaHours: number | null
}

type Option = { value: string; label: string }

// ── Filters ──────────────────────────────────────────────────────────────────

export function BoardFilters({
  owners,
  teams,
  canFilter,
}: {
  owners: Option[]
  teams: Option[]
  canFilter: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()

  if (!canFilter) return null

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    startTransition(() => router.push(`${pathname}?${next}`))
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <NativeSelect
        size="sm"
        aria-label="Filter by owner"
        value={params.get('owner') ?? ''}
        onChange={(e) => set('owner', e.target.value)}
      >
        <option value="">Any owner</option>
        {owners.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
      {teams.length > 0 && (
        <NativeSelect
          size="sm"
          aria-label="Filter by team"
          value={params.get('team') ?? ''}
          onChange={(e) => set('team', e.target.value)}
        >
          <option value="">Any team</option>
          {teams.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </NativeSelect>
      )}
      {pending && <Loader2 className="text-muted-foreground size-3.5 animate-spin" />}
    </div>
  )
}

// ── Cards ────────────────────────────────────────────────────────────────────

function CardBody({ card, dragging }: { card: BoardCard; dragging?: boolean }) {
  return (
    <div
      className={cn(
        'bg-card rounded-lg border p-2.5 text-sm transition-shadow',
        dragging ? 'shadow-e2 rotate-1' : 'shadow-e1',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/clients/${card.id}`}
          className="min-w-0 truncate font-medium hover:underline"
          draggable={false}
        >
          {card.name}
        </Link>
        {card.ownerName ? (
          <span
            title={card.ownerName}
            className="bg-primary/10 text-primary flex size-5 shrink-0 items-center justify-center rounded-full text-[0.625rem] font-semibold"
          >
            {initials(card.ownerName)}
          </span>
        ) : (
          <span
            title="Unassigned"
            className="bg-muted text-muted-foreground flex size-5 shrink-0 items-center justify-center rounded-full text-[0.625rem]"
          >
            —
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs tabular-nums">
          {card.value !== null ? currency(card.value) : 'No value yet'}
        </span>
        <SlaIndicator since={card.stageEnteredAt} slaHours={card.slaHours} />
      </div>
    </div>
  )
}

function DraggableCard({ card, canMove }: { card: BoardCard; canMove: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.id,
    disabled: !canMove,
  })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(canMove && 'cursor-grab touch-none active:cursor-grabbing', isDragging && 'opacity-40')}
    >
      <CardBody card={card} />
    </div>
  )
}

// ── Columns ──────────────────────────────────────────────────────────────────

function Column({
  lane,
  cards,
  canMove,
  activeLaneKey,
  allowedTargets,
}: {
  lane: BoardLane
  cards: BoardCard[]
  canMove: boolean
  /** Lane of the card currently being dragged, if any. */
  activeLaneKey: string | null
  allowedTargets: Set<string> | null
}) {
  const isSource = activeLaneKey === lane.key
  const isAllowed = allowedTargets ? allowedTargets.has(lane.key) : false
  const { setNodeRef, isOver } = useDroppable({
    id: lane.key,
    disabled: !canMove || (activeLaneKey !== null && !isAllowed && !isSource),
  })
  const dimmed = activeLaneKey !== null && !isAllowed && !isSource

  return (
    <section
      ref={setNodeRef}
      aria-label={`${lane.name} — ${cards.length} client${cards.length === 1 ? '' : 's'}`}
      className={cn(
        'bg-surface-sunk/60 flex max-h-[calc(100dvh-15rem)] w-68 shrink-0 flex-col rounded-xl border transition-all',
        isOver && isAllowed && 'border-primary ring-primary/30 ring-2',
        dimmed && 'opacity-45',
      )}
    >
      <header className="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5">
        <span className={cn('size-1.5 shrink-0 rounded-full', lane.dotClass)} aria-hidden />
        <h2 className="truncate text-xs font-semibold">{lane.name}</h2>
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">{cards.length}</span>
      </header>
      <p className="text-muted-foreground px-3 pb-2 text-[0.625rem] tracking-[0.06em] uppercase">
        {lane.categoryLabel}
      </p>
      <div className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2.5 pb-2.5">
        {cards.map((card) => (
          <DraggableCard key={card.id} card={card} canMove={canMove} />
        ))}
        {cards.length === 0 && (
          <p className="text-muted-foreground/70 rounded-lg border border-dashed px-2 py-4 text-center text-xs">
            {activeLaneKey && isAllowed ? 'Drop here' : 'Nobody in this stage'}
          </p>
        )}
      </div>
    </section>
  )
}

// ── Board ────────────────────────────────────────────────────────────────────

export function Board({
  lanes,
  cards: initialCards,
  canMove,
}: {
  lanes: BoardLane[]
  cards: BoardCard[]
  canMove: boolean
}) {
  const router = useRouter()
  const [cards, setCards] = useState(initialCards)
  const [activeId, setActiveId] = useState<string | null>(null)

  // Fresh server data replaces the optimistic copy (state-during-render pattern).
  const [prevInitial, setPrevInitial] = useState(initialCards)
  if (prevInitial !== initialCards) {
    setPrevInitial(initialCards)
    setCards(initialCards)
  }

  // A small drag threshold keeps the card's link clickable.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const laneByKey = useMemo(() => new Map(lanes.map((l) => [l.key, l])), [lanes])
  const activeCard = activeId ? (cards.find((c) => c.id === activeId) ?? null) : null
  const activeLane = activeCard ? (laneByKey.get(activeCard.stageKey) ?? null) : null
  const allowedTargets = activeLane ? new Set(activeLane.allowedNext) : null

  const onDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id))

  const onDragEnd = (event: DragEndEvent) => {
    setActiveId(null)
    const card = cards.find((c) => c.id === String(event.active.id))
    const targetKey = event.over ? String(event.over.id) : null
    if (!card || !targetKey || targetKey === card.stageKey) return

    const target = laneByKey.get(targetKey)
    if (!target) return

    // Optimistic move; the server is still the judge — a blocked move snaps back.
    const previous = cards
    setCards((prev) =>
      prev.map((c) =>
        c.id === card.id
          ? { ...c, stageKey: targetKey, slaHours: target.slaHours, stageEnteredAt: new Date().toISOString() }
          : c,
      ),
    )

    void moveCardAction({ clientId: card.id, toStageKey: targetKey }).then((result) => {
      if (result.ok) {
        toast.success(`${card.name} moved to ${target.name}.`)
        router.refresh()
      } else {
        setCards(previous)
        const detail = result.blockers?.length ? ` ${result.blockers.join(' ')}` : ''
        toast.error(`${result.error ?? 'This move is blocked.'}${detail}`)
      }
    })
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="flex items-start gap-3 overflow-x-auto p-4 sm:p-6">
        {lanes.map((lane) => (
          <Column
            key={lane.key}
            lane={lane}
            cards={cards.filter((c) => c.stageKey === lane.key)}
            canMove={canMove}
            activeLaneKey={activeCard?.stageKey ?? null}
            allowedTargets={allowedTargets}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeCard && (
          <div className="w-64">
            <div className="flex items-center gap-1">
              <GripVertical className="text-muted-foreground size-3.5" />
              <div className="flex-1">
                <CardBody card={activeCard} dragging />
              </div>
            </div>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}
