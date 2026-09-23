'use client'

import { useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { uiLocaleStore, type UiLocale } from '@/lib/ui-locale'

function Seg({
  code,
  selected,
  onSelect,
}: {
  code: UiLocale
  selected: boolean
  onSelect: (next: UiLocale) => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(code)}
      className={cn(
        'rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase',
        selected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {code === 'en' ? 'EN' : 'ES'}
    </button>
  )
}

export function LocaleSwitch({ className }: { className?: string }) {
  const locale = useSyncExternalStore(uiLocaleStore.subscribe, uiLocaleStore.get, () => 'en' as const)
  return (
    <div
      role="group"
      aria-label="Language"
      className={cn('inline-flex items-center rounded-md border border-border/70 px-0.5', className)}
    >
      <Seg code="en" selected={locale === 'en'} onSelect={(n) => uiLocaleStore.set(n)} />
      <span aria-hidden className="text-[11px] text-muted-foreground">|</span>
      <Seg code="es" selected={locale === 'es'} onSelect={(n) => uiLocaleStore.set(n)} />
    </div>
  )
}

export function useUiLocale(): UiLocale {
  return useSyncExternalStore(uiLocaleStore.subscribe, uiLocaleStore.get, () => 'en' as const)
}
