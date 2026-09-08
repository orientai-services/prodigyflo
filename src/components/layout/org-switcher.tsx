'use client'

import { useTransition } from 'react'
import { Check, ChevronsUpDown, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { OrgMark, hasOrgMark } from '@/components/brand/org-brand'
import { switchOrganizationAction } from '@/app/(app)/agency/actions'

export type SwitchableOrg = {
  id: string
  name: string
  /** 'AGENCY' for the home account, 'CLIENT' for its children. */
  kind: string
  /** Stable branding key — see components/brand/org-brand.tsx. */
  slug: string
}

/**
 * The agency account switcher. Rendered ONLY when the server-computed
 * switchable list is non-empty — every other user keeps the static org name.
 * Selecting an account calls the gated server action, which re-validates
 * eligibility, sets the signed cookie, audits, and redirects to /dashboard.
 *
 * `variant='rail'` is the desktop icon-rail rendering: the SAME trigger DOM,
 * with the name/chevron hidden by CSS keyed off the `pf-nav-open` html class,
 * so it collapses to a centered icon button that still opens the full
 * dropdown. A right-side tooltip names it while collapsed
 * (`tooltipDisabled` gates it off once the rail is expanded).
 */
export function OrgSwitcher({
  orgs,
  activeOrgId,
  variant = 'default',
  tooltipDisabled = true,
}: {
  orgs: SwitchableOrg[]
  activeOrgId: string
  variant?: 'default' | 'rail'
  tooltipDisabled?: boolean
}) {
  const [pending, startTransition] = useTransition()
  const active = orgs.find((o) => o.id === activeOrgId)
  const rail = variant === 'rail'

  const triggerButton = (
    <button
      type="button"
      disabled={pending}
      aria-label="Switch account"
      className={cn(
        'hover:bg-sidebar-accent/60 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors disabled:opacity-60',
        rail && 'justify-center gap-0 [.pf-nav-open_&]:justify-start [.pf-nav-open_&]:gap-2',
      )}
    />
  )

  const triggerContent = (
    <>
      {pending ? (
        <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
      ) : (
        // A branded account's mark carries its own colours; only the generic
        // fallback icon should be tinted to the muted foreground.
        <OrgMark
          slug={active?.slug}
          kind={active?.kind}
          className={cn('size-4 shrink-0', !hasOrgMark(active?.slug) && 'text-muted-foreground')}
        />
      )}
      <span className={cn('min-w-0 flex-1', rail && 'hidden [.pf-nav-open_&]:block')}>
        <span className="block truncate font-medium">{active?.name ?? 'Account'}</span>
        <span className="text-muted-foreground block truncate text-xs">
          {active?.kind === 'AGENCY' ? 'Agency account' : 'Client account'}
        </span>
      </span>
      <ChevronsUpDown
        className={cn('text-muted-foreground size-3.5 shrink-0', rail && 'hidden [.pf-nav-open_&]:block')}
      />
    </>
  )

  return (
    <DropdownMenu>
      {rail ? (
        <Tooltip disabled={tooltipDisabled}>
          <TooltipTrigger render={<DropdownMenuTrigger render={triggerButton} />}>
            {triggerContent}
          </TooltipTrigger>
          <TooltipContent side="right">{active?.name ?? 'Switch account'}</TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger render={triggerButton}>{triggerContent}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="start" className="w-60">
        {/* Base UI GroupLabels must live inside a Group — bare ones crash the menu. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
            Switch account
          </DropdownMenuLabel>
          {orgs.map((org) => {
            const isActive = org.id === activeOrgId
            return (
              <DropdownMenuItem
                key={org.id}
                disabled={pending}
                onClick={() => {
                  if (isActive) return
                  startTransition(() => switchOrganizationAction(org.id))
                }}
              >
                <OrgMark slug={org.slug} kind={org.kind} className="size-4" />
                <span className={cn('min-w-0 flex-1 truncate', isActive && 'font-medium')}>
                  {org.name}
                </span>
                {isActive && <Check className="size-4 shrink-0" />}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
