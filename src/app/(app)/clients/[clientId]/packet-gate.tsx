'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { closerYesAction } from './packet-actions'

export function PacketGate({
  clientId,
  floorStampedReady,
  closerApproved,
  holdReason,
}: {
  clientId: string
  floorStampedReady: boolean
  closerApproved: boolean
  holdReason: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [busy, setBusy] = useState(false)

  if (closerApproved) {
    return <p className="text-sm">Closer said YES. Strawberry may type. Human Submit — WAIT FOR HUMAN.</p>
  }

  if (!floorStampedReady) {
    return <p className="text-sm">{holdReason}</p>
  }

  return (
    <div className="space-y-2">
      <p className="text-sm">{holdReason}</p>
      <Button
        type="button"
        size="sm"
        disabled={busy || pending}
        onClick={() => {
          setBusy(true)
          start(async () => {
            const result = await closerYesAction({ clientId })
            if (!result.ok) toast.error(result.error)
            else {
              toast.success('Closer YES recorded. Strawberry may type. Do not Submit.')
              router.refresh()
            }
            setBusy(false)
          })
        }}
      >
        Yes — send to Strawberry
      </Button>
    </div>
  )
}
