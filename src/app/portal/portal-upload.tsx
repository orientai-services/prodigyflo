'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

/**
 * One-tap upload for a single requirement. Posts to the portal-scoped
 * /portal/upload route (never the staff endpoint) and refreshes the
 * server-rendered checklist so the new status appears immediately.
 */
export function PortalUpload({
  requirementId,
  buttonLabel,
  busyLabel,
  successMessage,
  failureMessage,
  emphasized = false,
}: {
  requirementId: string
  buttonLabel: string
  busyLabel: string
  successMessage: string
  failureMessage: string
  emphasized?: boolean
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    try {
      const form = new FormData()
      form.set('file', file)
      form.set('requirementId', requirementId)

      const res = await fetch('/portal/upload', { method: 'POST', body: form })
      const body = (await res.json().catch(() => null)) as { error?: string } | null

      if (!res.ok) {
        toast.error(body?.error ?? failureMessage)
        return
      }
      toast.success(successMessage)
      router.refresh()
    } catch {
      toast.error(failureMessage)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        hidden
        accept=".pdf,.jpg,.jpeg,.png,.heic,.webp,.txt,application/pdf,image/*,text/plain"
        onChange={(e) => onFile(e.target.files?.[0])}
      />
      <Button
        size="sm"
        variant={emphasized ? 'default' : 'outline'}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
        {busy ? busyLabel : buttonLabel}
      </Button>
    </>
  )
}
