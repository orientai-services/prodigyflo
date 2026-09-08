'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import * as Icons from 'lucide-react'
import { Loader2, User } from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import type { NavItem, NavSection } from '@/lib/navigation'

type SearchHit = {
  id: string
  label: string
  sublabel: string
  href: string
  kind: 'client' | 'user'
}

function NavIcon({ name }: { name: string }) {
  const Icon = (Icons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[name]
  return Icon ? <Icon className="size-4" /> : <Icons.Circle className="size-4" />
}

/** "/sales/hot-leads" → ["sales", "hot", "leads"] — extra case-insensitive match words. */
function hrefWords(href: string): string[] {
  return href.split(/[/-]/).filter(Boolean)
}

export function CommandPalette({
  open,
  onOpenChange,
  sections,
  subroutes = [],
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sections: NavSection[]
  /** Permission-filtered deep links (subroutesFor(user)) shown under "Go deeper". */
  subroutes?: NavItem[]
}) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [loading, startLoading] = useTransition()

  const [wasOpen, setWasOpen] = useState(open)

  // Reopening starts from a blank query. Adjusted during render rather than in
  // an effect so the stale term never paints.
  if (wasOpen !== open) {
    setWasOpen(open)
    if (!open) setQuery('')
  }

  const term = query.trim()
  // Below the threshold there is nothing to show; derived rather than stored, so
  // clearing the input cannot leave stale results behind.
  const visibleHits = term.length < 2 ? [] : hits

  useEffect(() => {
    if (term.length < 2) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      startLoading(async () => {
        try {
          const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, {
            signal: controller.signal,
          })
          if (res.ok) setHits((await res.json()).results ?? [])
        } catch {
          // aborted or offline — the previous results stay on screen
        }
      })
    }, 180)

    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [term])

  const go = (href: string) => {
    onOpenChange(false)
    router.push(href)
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search" description="Find clients, people, and pages">
      <CommandInput placeholder="Search clients, people, pages…" value={query} onValueChange={setQuery} />
      <CommandList>
        {loading && (
          <div className="text-muted-foreground flex items-center gap-2 px-3 py-4 text-sm">
            <Loader2 className="size-3.5 animate-spin" /> Searching…
          </div>
        )}

        {!loading && term.length >= 2 && visibleHits.length === 0 && (
          <CommandEmpty>No matches for “{query.trim()}”.</CommandEmpty>
        )}

        {visibleHits.length > 0 && (
          <>
            <CommandGroup heading="Records">
              {visibleHits.map((hit) => (
                <CommandItem key={`${hit.kind}-${hit.id}`} value={`${hit.label} ${hit.sublabel}`} onClick={() => go(hit.href)}>
                  <User className="size-4" />
                  <span>{hit.label}</span>
                  <span className="text-muted-foreground ml-2 truncate text-xs">{hit.sublabel}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {sections.map((section) => (
          <CommandGroup key={section.title} heading={section.title}>
            {section.items.map((item) => (
              <CommandItem
                key={item.href}
                value={`${section.title} ${item.label}`}
                keywords={hrefWords(item.href)}
                onClick={() => go(item.href)}
              >
                <NavIcon name={item.icon} />
                <span>{item.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}

        {subroutes.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Go deeper">
              {subroutes.map((item) => (
                <CommandItem
                  key={item.href}
                  value={`Go deeper ${item.label}`}
                  keywords={hrefWords(item.href)}
                  onClick={() => go(item.href)}
                >
                  <NavIcon name={item.icon} />
                  <span>{item.label}</span>
                  <span className="text-muted-foreground ml-2 truncate text-xs">{item.href}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}
