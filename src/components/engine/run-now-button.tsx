'use client'

import { useActionState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { runInsightScanAction, type RunScanActionResult } from '@/lib/engine/actions'
import { Button } from '@/components/ui/button'

/**
 * "Run now" island. The server renders `activeRun` (hasActiveRun) so the
 * button arrives already disabled while a scan is in flight; the action
 * re-checks both the ai:run permission and the active run server-side, so the
 * disabled state is a courtesy, never the gate.
 */
export function RunNowButton({ activeRun }: { activeRun: boolean }) {
  const [, formAction, pending] = useActionState<RunScanActionResult | null, FormData>(
    async () => {
      const result = await runInsightScanAction()
      if (result.ok) {
        toast.success('Insight scan started', {
          description: 'Steps advance with the engine tick — results land here in a few minutes.',
        })
      } else {
        toast.error(result.error)
      }
      return result
    },
    null,
  )

  const busy = pending || activeRun
  return (
    <form action={formAction}>
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? (
          <Loader2 data-slot="icon" className="motion-safe:animate-spin" />
        ) : (
          <Sparkles data-slot="icon" />
        )}
        {activeRun ? 'Scan running…' : 'Run now'}
      </Button>
    </form>
  )
}
