'use client'

import { useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { LogOut, Monitor, Moon, Sun, UserRound } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

type Theme = 'light' | 'dark' | 'system'

/**
 * The stored theme lives in localStorage, which the server cannot read. Exposing
 * it as an external store lets the menu render from it directly instead of
 * correcting itself in an effect after hydration.
 */
const listeners = new Set<() => void>()

const themeStore = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    window.addEventListener('storage', listener)
    return () => {
      listeners.delete(listener)
      window.removeEventListener('storage', listener)
    }
  },
  get(): Theme {
    return (localStorage.getItem('pf-theme') as Theme | null) ?? 'system'
  },
  set(next: Theme) {
    if (next === 'system') localStorage.removeItem('pf-theme')
    else localStorage.setItem('pf-theme', next)
    listeners.forEach((l) => l())
  },
}

function initials(name: string) {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export function UserMenu({
  user,
}: {
  user: { name: string; email: string; roleName: string; avatarUrl: string | null }
}) {
  const router = useRouter()
  const theme = useSyncExternalStore(themeStore.subscribe, themeStore.get, () => 'system' as Theme)

  const applyTheme = (next: Theme) => {
    const dark =
      next === 'dark' || (next === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.classList.toggle('dark', dark)
    themeStore.set(next)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label="Account menu">
            <Avatar className="size-7">
              {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" />}
              <AvatarFallback className="text-[0.65rem]">{initials(user.name)}</AvatarFallback>
            </Avatar>
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-60">
        {/* Base UI GroupLabels must live inside a Group — bare ones crash the menu. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <div className="truncate font-medium">{user.name}</div>
            <div className="text-muted-foreground truncate text-xs font-normal">{user.email}</div>
            <div className="text-muted-foreground mt-1 text-xs font-normal">{user.roleName}</div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => applyTheme(v as Theme)}>
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">Appearance</DropdownMenuLabel>
          <DropdownMenuRadioItem value="light">
            <Sun className="size-4" /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="size-4" /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor className="size-4" /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={() => router.push('/settings/profile')}>
          <UserRound className="size-4" /> My profile
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={() => {
            const form = document.createElement('form')
            form.method = 'POST'
            form.action = '/api/signout'
            document.body.appendChild(form)
            form.submit()
          }}
        >
          <LogOut className="size-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
