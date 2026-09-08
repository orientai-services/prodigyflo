'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, RefreshCw, Radio, PlugZap } from 'lucide-react'
import { cn } from '@/lib/utils'

const ITEMS = [
  { href: '/recovery', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/recovery/leads', label: 'Recover', icon: RefreshCw, exact: false },
  { href: '/recovery/inbound', label: 'Inbound', icon: Radio, exact: false },
  { href: '/recovery/sources', label: 'Sources', icon: PlugZap, exact: false },
] as const

export function RecoveryNav() {
  const pathname = usePathname()

  return (
    <nav className="scroll-x -mb-px flex items-center gap-1">
      {ITEMS.map((item) => {
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href)
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors',
              active
                ? 'bg-[var(--rec-primary)] text-[var(--rec-on-primary)] shadow-sm'
                : 'text-[var(--rec-muted)] hover:bg-[var(--rec-primary-soft)] hover:text-[var(--rec-primary-ink)]',
            )}
          >
            <Icon className="size-4" />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
