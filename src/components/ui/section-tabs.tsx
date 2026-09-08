'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

export type SectionTab = {
  key: string
  label: string
  href: string
}

/**
 * Section strip: a unified pill rail for sibling routes (perspective tabs).
 * Link-based so it composes into RSC pages — navigation is a real page
 * change, filter/tab state stays in the URL. The active pill is a single
 * indicator that slides between labels (measured, so it tracks any label
 * width); until the first client measurement the active link paints its own
 * pill, so SSR and no-JS render identically.
 */
export function SectionTabs({
  tabs,
  active,
  className,
  'aria-label': ariaLabel = 'Section',
}: {
  tabs: readonly SectionTab[]
  active: string
  className?: string
  'aria-label'?: string
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null)

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = () => {
      const el = list.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`)
      if (el) setIndicator({ left: el.offsetLeft, width: el.offsetWidth })
    }
    measure()
    // Re-measure when the rail resizes (font swap, container queries, rotation).
    const ro = new ResizeObserver(measure)
    ro.observe(list)
    return () => ro.disconnect()
  }, [active])

  return (
    <nav aria-label={ariaLabel} className={cn('scroll-x no-scrollbar mt-4', className)}>
      <div
        ref={listRef}
        className="bg-muted relative inline-flex items-center gap-0.5 rounded-full border p-0.5"
      >
        {indicator && (
          <span
            aria-hidden
            className="bg-background shadow-e1 absolute inset-y-0.5 rounded-full border motion-safe:transition-[left,width] motion-safe:duration-200 motion-safe:ease-out"
            style={{ left: indicator.left, width: indicator.width }}
          />
        )}
        {tabs.map((tab) => {
          const isActive = tab.key === active
          return (
            <Link
              key={tab.key}
              data-key={tab.key}
              href={tab.href}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'relative rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                // SSR / pre-measure fallback: the active link paints its own pill
                // until the sliding indicator takes over in the same commit.
                isActive && !indicator && 'bg-background shadow-e1 border',
              )}
            >
              {tab.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
