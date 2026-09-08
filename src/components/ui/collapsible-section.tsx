'use client'

import { useId, useState, useSyncExternalStore } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

const STORAGE_PREFIX = 'pf-section:'

/** localStorage can throw (private mode, disabled storage) — always guard. */
function readStoredOpen(storageKey: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + storageKey)
    return raw === null ? null : raw === '1'
  } catch {
    return null
  }
}

function writeStoredOpen(storageKey: string, open: boolean) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + storageKey, open ? '1' : '0')
  } catch {
    // Persistence is a convenience — never let it break the toggle.
  }
}

// localStorage is an external store: subscribing via useSyncExternalStore keeps
// SSR/hydration consistent (server snapshot = null → defaultOpen) and syncs the
// same section across tabs and duplicate mounts for free.
const storeListeners = new Set<() => void>()

function subscribeToSectionStore(onChange: () => void) {
  storeListeners.add(onChange)
  window.addEventListener('storage', onChange)
  return () => {
    storeListeners.delete(onChange)
    window.removeEventListener('storage', onChange)
  }
}

function emitSectionStore() {
  for (const listener of storeListeners) listener()
}

const serverSnapshot = () => null

/**
 * A collapsible content group: chevron header, optional summary chip while
 * collapsed, and animated height via the grid-template-rows 0fr→1fr trick
 * (works with auto-height content; motion-safe so reduced-motion users get an
 * instant toggle). Open state persists per `storageKey` in localStorage.
 *
 * `variant="plain"` is a bare section header for grouping existing cards;
 * `variant="card"` draws the card chrome itself for naked content.
 */
export function CollapsibleSection({
  title,
  description,
  summary,
  actions,
  defaultOpen = true,
  storageKey,
  variant = 'plain',
  className,
  contentClassName,
  children,
}: {
  title: React.ReactNode
  description?: string
  /** Chip shown in the header only while collapsed — a count or micro-summary. */
  summary?: React.ReactNode
  /** Interactive extras (links, buttons) — rendered OUTSIDE the toggle button. */
  actions?: React.ReactNode
  defaultOpen?: boolean
  /** Persist the open state under this key; omit for ephemeral sections. */
  storageKey?: string
  variant?: 'plain' | 'card'
  className?: string
  contentClassName?: string
  children: React.ReactNode
}) {
  const [localOpen, setLocalOpen] = useState(defaultOpen)
  const stored = useSyncExternalStore(
    subscribeToSectionStore,
    () => (storageKey ? readStoredOpen(storageKey) : null),
    serverSnapshot,
  )
  const open = stored ?? localOpen
  const panelId = useId()

  const toggle = () => {
    const next = !open
    setLocalOpen(next)
    if (storageKey) {
      writeStoredOpen(storageKey, next)
      emitSectionStore()
    }
  }

  const isCard = variant === 'card'

  return (
    <section
      data-state={open ? 'open' : 'closed'}
      className={cn(isCard && 'bg-card shadow-e1 rounded-xl border', className)}
    >
      <div className={cn('flex items-center gap-2', isCard ? 'px-4 py-3' : 'pb-0.5')}>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={panelId}
          className="group/section focus-visible:ring-ring/50 -m-1 flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left outline-none focus-visible:ring-2"
        >
          <ChevronDown
            aria-hidden
            className={cn(
              'text-muted-foreground group-hover/section:text-foreground size-4 shrink-0 transition-colors motion-safe:transition-transform',
              !open && '-rotate-90',
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="text-foreground block truncate text-sm font-semibold">{title}</span>
            {description && (
              <span className="text-muted-foreground mt-0.5 block truncate text-xs font-normal">
                {description}
              </span>
            )}
          </span>
          {!open && summary != null && (
            <span className="bg-muted text-muted-foreground motion-safe:animate-in motion-safe:fade-in inline-flex max-w-48 shrink-0 items-center truncate rounded-full px-2 py-0.5 text-xs font-medium tabular-nums">
              {summary}
            </span>
          )}
        </button>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>

      <div
        id={panelId}
        inert={open ? undefined : true}
        className={cn(
          'grid motion-safe:transition-[grid-template-rows] motion-safe:duration-300 motion-safe:ease-in-out',
          open ? '[grid-template-rows:1fr]' : '[grid-template-rows:0fr]',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className={cn(isCard ? 'border-t' : 'pt-2', contentClassName)}>{children}</div>
        </div>
      </div>
    </section>
  )
}
