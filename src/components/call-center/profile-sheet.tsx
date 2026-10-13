'use client'

import Link from 'next/link'
import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Camera, Loader2, LogOut, Trash2, UserRound } from 'lucide-react'
import { saveNameAction } from '@/app/(app)/settings/profile/actions'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { profileInitials, profileName } from '@/lib/people/profile-name'
import { squareCrop } from '@/lib/profile/avatar-crop'

/** Who is signed in, as the Call Center header shows them. */
export type ViewerProfile = {
  name: string
  nickname: string | null
  email: string
  role: string
  avatarUrl: string | null
}

/**
 * The centered square of the picked photo, redrawn as a 512 px JPEG so a
 * phone's 4 MB camera shot fits the 2 MB limit. A picture the browser cannot
 * decode (HEIC on Chrome, a PDF renamed .jpg) goes up as it is and the
 * upload route answers with its own reason.
 */
async function cropToSquare(file: File): Promise<File> {
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(file)
  } catch {
    return file
  }
  try {
    const crop = squareCrop(bmp.width, bmp.height)
    if (!crop) return file
    const canvas = document.createElement('canvas')
    canvas.width = crop.out
    canvas.height = crop.out
    const cx = canvas.getContext('2d')
    if (!cx) return file
    cx.fillStyle = '#fff'
    cx.fillRect(0, 0, crop.out, crop.out)
    cx.drawImage(bmp, crop.sx, crop.sy, crop.side, crop.side, 0, 0, crop.out, crop.out)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
    return blob ? new File([blob], 'avatar.jpg', { type: 'image/jpeg' }) : file
  } finally {
    bmp.close?.()
  }
}

/** POST /api/profile/avatar with upload progress (fetch has none). */
function uploadAvatar(file: File, onProgress: (pct: number) => void): Promise<{ avatarUrl?: string; error?: string }> {
  return new Promise((resolve) => {
    const body = new FormData()
    body.set('file', file)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/profile/avatar')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
    }
    xhr.onload = () => {
      let data: { avatarUrl?: string; error?: string } = {}
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        // A proxy's HTML error page: the status decides below.
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.avatarUrl) resolve({ avatarUrl: data.avatarUrl })
      else if (xhr.status === 413) resolve({ error: 'That image is too big. The limit is 2 MB.' })
      else resolve({ error: data.error ?? 'The photo could not be uploaded.' })
    }
    xhr.onerror = () => resolve({ error: 'The photo could not be uploaded. Check your connection and try again.' })
    xhr.send(body)
  })
}

function signOut() {
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = '/api/signout'
  document.body.appendChild(form)
  form.submit()
}

/**
 * The round picture in the Call Center header (the full-screen dialer has no
 * app menu): the user's photo, else their initials. It opens the Profile
 * sheet, a bottom sheet on a phone and a dialog on a desk, where the photo
 * and the name change without leaving the dialer. Saving refreshes the page,
 * so the header and every place that shows the name pick it up.
 */
export function ProfileButton({ profile }: { profile: ViewerProfile }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)

  // What this sheet just saved, shown until the refreshed props agree.
  const propKey = `${profile.avatarUrl}|${profile.name}|${profile.nickname}`
  const [seenKey, setSeenKey] = useState(propKey)
  const [saved, setSaved] = useState<{ avatarUrl?: string | null; name?: string; nickname?: string | null }>({})
  if (seenKey !== propKey) {
    setSeenKey(propKey)
    setSaved({})
  }
  const avatarUrl = saved.avatarUrl !== undefined ? saved.avatarUrl : profile.avatarUrl
  const current = {
    name: saved.name ?? profile.name,
    nickname: saved.nickname !== undefined ? saved.nickname : profile.nickname,
    email: profile.email,
  }
  const shown = profileName(current) ?? 'You'

  const [imgFailed, setImgFailed] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [photoBusy, setPhotoBusy] = useState<'upload' | 'remove' | null>(null)
  const [progress, setProgress] = useState(0)
  const [photoError, setPhotoError] = useState<string | null>(null)

  const [name, setName] = useState(current.name)
  const [nickname, setNickname] = useState(current.nickname ?? '')
  const [nameError, setNameError] = useState<string | null>(null)
  const [nameOk, setNameOk] = useState<string | null>(null)
  const [saving, startSave] = useTransition()

  const picture = preview ?? (avatarUrl && imgFailed !== avatarUrl ? avatarUrl : null)

  function onOpenChange(next: boolean) {
    if (next) {
      setName(current.name)
      setNickname(current.nickname ?? '')
      setNameError(null)
      setNameOk(null)
      setPhotoError(null)
    }
    setOpen(next)
  }

  async function pick(file: File) {
    setPhotoError(null)
    setPhotoBusy('upload')
    setProgress(0)
    const local = URL.createObjectURL(file)
    setPreview(local)
    try {
      const ready = await cropToSquare(file)
      const res = await uploadAvatar(ready, setProgress)
      if (res.avatarUrl) {
        setSaved((s) => ({ ...s, avatarUrl: res.avatarUrl }))
        router.refresh()
      } else {
        setPhotoError(res.error ?? 'The photo could not be uploaded.')
      }
    } finally {
      setPreview(null)
      URL.revokeObjectURL(local)
      setPhotoBusy(null)
    }
  }

  async function remove() {
    setPhotoError(null)
    setPhotoBusy('remove')
    try {
      const res = await fetch('/api/profile/avatar', { method: 'DELETE' })
      if (!res.ok) {
        setPhotoError('The photo could not be removed. Try again.')
        return
      }
      setSaved((s) => ({ ...s, avatarUrl: null }))
      router.refresh()
    } catch {
      setPhotoError('The photo could not be removed. Check your connection and try again.')
    } finally {
      setPhotoBusy(null)
    }
  }

  function save(event: React.FormEvent) {
    event.preventDefault()
    setNameError(null)
    setNameOk(null)
    startSave(async () => {
      try {
        const res = await saveNameAction({ name, nickname })
        if (res.error) {
          setNameError(res.error)
          return
        }
        setSaved((s) => ({ ...s, name: res.name ?? name.trim(), nickname: res.nickname ?? null }))
        setNameOk('Saved.')
        router.refresh()
      } catch {
        setNameError('Your name could not be saved. Check your connection and try again.')
      }
    })
  }

  const face = (size: 'head' | 'big') =>
    picture ? (
      // eslint-disable-next-line @next/next/no-img-element -- the app's own avatar route; next/image adds nothing for a 40 px circle
      <img
        src={picture}
        alt=""
        width={size === 'big' ? 88 : 40}
        height={size === 'big' ? 88 : 40}
        className="cc-me-img"
        onError={() => {
          if (picture === avatarUrl) setImgFailed(avatarUrl)
        }}
      />
    ) : (
      <span className="cc-me-initials" aria-hidden="true">{profileInitials(shown)}</span>
    )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <button type="button" className="cc-me" aria-label={`Your profile: ${shown}`} title="Your profile" />
        }
      >
        {face('head')}
      </DialogTrigger>
      <DialogContent
        className={[
          'cc-profile max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto p-5 sm:max-w-md',
          // A bottom sheet on a phone, docs/MOBILE.md: thumb-reach actions, safe area.
          'max-md:top-auto max-md:bottom-0 max-md:left-0 max-md:max-h-[90dvh] max-md:w-full max-md:max-w-full max-md:translate-x-0 max-md:translate-y-0',
          'max-md:rounded-b-none max-md:pb-[calc(env(safe-area-inset-bottom)+1.25rem)]',
        ].join(' ')}
      >
        <DialogHeader>
          <DialogTitle>Your profile</DialogTitle>
          <DialogDescription>How your teammates see you in the dialer and the team chat.</DialogDescription>
        </DialogHeader>

        <section className="flex items-center gap-4" aria-label="Photo">
          <div className="relative size-[88px] shrink-0">
            <div className="cc-me-big">{face('big')}</div>
            {photoBusy === 'upload' ? (
              <span className="bg-background/60 absolute inset-0 grid place-items-center rounded-full text-xs font-semibold tabular-nums">
                {progress > 0 && progress < 100 ? `${progress}%` : <Loader2 className="size-5 motion-safe:animate-spin" aria-hidden />}
              </span>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/*"
              className="sr-only"
              aria-label="Choose a profile photo"
              tabIndex={-1}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void pick(file)
              }}
            />
            <Button
              type="button"
              variant="outline"
              className="min-h-11 justify-start md:min-h-9"
              disabled={photoBusy !== null}
              onClick={() => inputRef.current?.click()}
            >
              <Camera className="size-4" aria-hidden />
              {photoBusy === 'upload' ? 'Uploading…' : avatarUrl ? 'Change photo' : 'Add a photo'}
            </Button>
            {avatarUrl ? (
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 justify-start md:min-h-9"
                disabled={photoBusy !== null}
                onClick={() => void remove()}
              >
                {photoBusy === 'remove' ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
                Remove photo
              </Button>
            ) : null}
          </div>
        </section>
        {photoBusy === 'upload' ? (
          <div
            className="bg-muted h-1.5 overflow-hidden rounded-full"
            role="progressbar"
            aria-label="Uploading photo"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <div className="bg-primary h-full motion-safe:transition-[width]" style={{ width: `${progress}%` }} />
          </div>
        ) : null}
        {photoError ? (
          <p role="alert" className="text-destructive -mt-2 text-sm">{photoError}</p>
        ) : (
          <p className="text-muted-foreground -mt-2 text-xs">JPEG, PNG or WebP. We crop it to a square around the middle.</p>
        )}

        <form onSubmit={save} className="grid gap-3" noValidate>
          <div className="grid gap-1.5">
            <Label htmlFor="cc-profile-name">Full name</Label>
            <Input
              id="cc-profile-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
              maxLength={80}
              required
              className="h-11 text-base md:h-9 md:text-sm"
              aria-invalid={Boolean(nameError)}
              aria-describedby={nameError ? 'cc-profile-msg' : undefined}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cc-profile-nick">Nickname <span className="text-muted-foreground font-normal">(optional, shown instead of your name)</span></Label>
            <Input
              id="cc-profile-nick"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              autoComplete="nickname"
              maxLength={40}
              className="h-11 text-base md:h-9 md:text-sm"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <p id="cc-profile-msg" role={nameError ? 'alert' : 'status'} className={`min-w-0 text-sm ${nameError ? 'text-destructive' : 'text-muted-foreground'}`}>
              {nameError ?? nameOk ?? ''}
            </p>
            <Button type="submit" className="min-h-11 shrink-0 px-5 md:min-h-9" disabled={saving}>
              {saving ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : null}
              Save
            </Button>
          </div>
        </form>

        <div className="grid gap-1 border-t pt-3">
          <p className="text-muted-foreground truncate text-xs">
            Signed in as {profile.email} · {profile.role}
          </p>
          <Link
            href="/settings/profile"
            className="hover:bg-muted flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium md:min-h-9"
            onClick={() => setOpen(false)}
          >
            <UserRound className="size-4" aria-hidden /> All profile settings
          </Link>
          <button
            type="button"
            className="hover:bg-muted flex min-h-11 items-center gap-2 rounded-md px-2 text-left text-sm font-medium md:min-h-9"
            onClick={signOut}
          >
            <LogOut className="size-4" aria-hidden /> Sign out
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
