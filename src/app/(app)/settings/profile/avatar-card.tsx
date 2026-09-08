'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Camera, Loader2, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

function initials(name: string) {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

/**
 * Profile photo. The picked file previews optimistically via an object URL
 * while the upload runs; on success router.refresh() re-reads the session
 * user so the header menu and every other Avatar pick up the new photo.
 * Validation is client-hinted (accept, size) but decided server-side by
 * magic bytes — this card just relays the route's friendly errors.
 */
export function AvatarCard({ initial }: { initial: { name: string; avatarUrl: string | null } }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [avatarUrl, setAvatarUrl] = useState(initial.avatarUrl)
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null)

  // Object URLs leak until revoked; one live preview at a time.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview)
    }
  }, [preview])

  const upload = async (file: File) => {
    setBusy('upload')
    setPreview(URL.createObjectURL(file))
    try {
      const body = new FormData()
      body.set('file', file)
      const res = await fetch('/api/profile/avatar', { method: 'POST', body })
      const data = (await res.json().catch(() => ({}))) as { avatarUrl?: string; error?: string }
      if (!res.ok || !data.avatarUrl) {
        setPreview(null)
        toast.error(data.error ?? 'The photo could not be uploaded.')
        return
      }
      setAvatarUrl(data.avatarUrl)
      toast.success('Profile photo updated.')
      router.refresh()
    } catch {
      setPreview(null)
      toast.error('The photo could not be uploaded. Check your connection and try again.')
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    setBusy('remove')
    try {
      const res = await fetch('/api/profile/avatar', { method: 'DELETE' })
      if (!res.ok) {
        toast.error('The photo could not be removed.')
        return
      }
      setAvatarUrl(null)
      setPreview(null)
      toast.success('Profile photo removed.')
      router.refresh()
    } catch {
      toast.error('The photo could not be removed. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const shown = preview ?? avatarUrl

  return (
    <Card>
      <CardContent>
        <div className="flex items-center gap-4">
          <div className="relative">
            <Avatar size="lg" className="size-16 motion-safe:transition-opacity data-[busy=true]:opacity-60" data-busy={busy === 'upload'}>
              {shown && <AvatarImage src={shown} alt="" />}
              <AvatarFallback className="text-lg">{initials(initial.name)}</AvatarFallback>
            </Avatar>
            {busy === 'upload' && (
              <span className="absolute inset-0 grid place-items-center rounded-full bg-background/40">
                <Loader2 className="size-5 motion-safe:animate-spin" aria-hidden />
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <div className="bg-brand-soft text-brand grid size-9 shrink-0 place-items-center rounded-lg">
                <Camera className="size-4.5" />
              </div>
              <div>
                <h2 className="font-semibold">Photo</h2>
                <p className="text-muted-foreground text-xs">
                  Shown in the header and next to your activity. JPEG, PNG, or WebP — up to 2 MB.
                </p>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/*"
              className="sr-only"
              aria-label="Choose a profile photo"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void upload(file)
              }}
            />
            {avatarUrl && (
              <Button variant="ghost" size="sm" onClick={() => void remove()} disabled={busy !== null}>
                {busy === 'remove' ? <Loader2 className="size-4 motion-safe:animate-spin" /> : <Trash2 className="size-4" />}
                Remove
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={busy !== null}>
              <Upload className="size-4" />
              {busy === 'upload' ? 'Uploading…' : avatarUrl ? 'Replace' : 'Upload'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
