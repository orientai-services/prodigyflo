'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

/**
 * Uploads one file against a requirement (or as an ad-hoc document) via
 * POST /api/documents/upload, then refreshes the server-rendered view so the
 * new version and its extraction outcome appear immediately.
 */
export function UploadButton({
  clientId,
  requirementId,
  label,
  buttonLabel = 'Upload',
  variant = 'outline',
}: {
  clientId: string
  requirementId?: string
  label?: string
  buttonLabel?: string
  variant?: 'outline' | 'secondary' | 'ghost'
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
      form.set('clientId', clientId)
      if (requirementId) form.set('requirementId', requirementId)
      if (label) form.set('label', label)

      const res = await fetch('/api/documents/upload', { method: 'POST', body: form })
      const body = (await res.json().catch(() => null)) as
        | { error?: string; extraction?: { status: string; documentStatus: string; missingFieldKeys: string[]; error?: string } }
        | null

      if (!res.ok) {
        toast.error(body?.error ?? 'Upload failed.')
        return
      }
      const ex = body?.extraction
      if (ex?.status === 'FAILED') {
        toast.warning(`Uploaded, but extraction failed: ${ex.error ?? 'unknown error'}. You can re-run it from review.`)
      } else if (ex?.documentStatus === 'MISSING_INFORMATION') {
        toast.warning(`Uploaded. ${ex.missingFieldKeys.length} required field(s) could not be read — review needed.`)
      } else {
        toast.success('Uploaded and extracted — ready for review.')
      }
      router.refresh()
    } catch {
      toast.error('Upload did not finish. Check the document list before retrying.');
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
      <Button size="sm" variant={variant} disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
        {busy ? 'Uploading…' : buttonLabel}
      </Button>
    </>
  )
}
