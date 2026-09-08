'use client'

import { useTransition } from 'react'
import { ArrowRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { switchOrganizationAction } from './actions'

/**
 * Switches the active organization and lands on /dashboard. The action
 * re-validates eligibility server-side; this button only expresses intent.
 */
export function OpenAccountButton({ orgId }: { orgId: string }) {
  const [pending, startTransition] = useTransition()
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() => startTransition(() => switchOrganizationAction(orgId))}
    >
      {pending ? (
        <Loader2 data-slot="icon" className="animate-spin" />
      ) : (
        <ArrowRight data-slot="icon" />
      )}
      Open
    </Button>
  )
}
