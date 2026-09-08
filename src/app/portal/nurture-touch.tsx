'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { NurtureKind } from '@prisma/client'
import { Check, ChevronDown, ExternalLink, Loader2, Mail, MessageSquareText, Play, Video } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { confirmPortalNurture } from './actions'

const KIND_ICONS: Record<NurtureKind, typeof Video> = {
  VIDEO: Video,
  EMAIL: Mail,
  SMS: MessageSquareText,
  CALL_PREP: MessageSquareText,
}

/**
 * One touch from the advisor. Opening it IS the confirmation:
 * - url touches open in a new tab (synchronously, so popup blockers stay
 *   quiet) and confirm in the background;
 * - note-only touches confirm the first time the note is expanded.
 * Nothing here decides anything — it just records that the client engaged.
 */
export function NurtureTouchRow({
  touchId,
  kind,
  kindLabel,
  url,
  note,
  sentLabel,
  senderFirstName,
  confirmed,
}: {
  touchId: string
  kind: NurtureKind
  kindLabel: string
  url: string | null
  note: string | null
  sentLabel: string
  senderFirstName: string
  confirmed: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [expanded, setExpanded] = useState(confirmed)
  const Icon = KIND_ICONS[kind]

  const confirm = () => {
    if (confirmed) return
    startTransition(async () => {
      const res = await confirmPortalNurture({ touchId })
      if (res.ok) router.refresh()
      else toast.error(res.error)
    })
  }

  const openLink = () => {
    if (!url) return
    // Open first — synchronously, inside the click — then record the view.
    window.open(url, '_blank', 'noopener,noreferrer')
    confirm()
  }

  const toggleNote = () => {
    const next = !expanded
    setExpanded(next)
    if (next) confirm()
  }

  const hasNoteOnly = !url && !!note

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-full',
            confirmed ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400' : 'bg-brand-soft text-brand',
          )}
          aria-hidden
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">
              {kindLabel} from {senderFirstName}
            </p>
            {confirmed && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                <Check className="size-3" /> {kind === 'VIDEO' ? 'Watched' : 'Opened'}
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs">Sent {sentLabel}</p>
          {url && note && <p className="text-muted-foreground mt-1 text-xs whitespace-pre-wrap">{note}</p>}
        </div>
        {url && (
          <Button size="sm" variant={confirmed ? 'outline' : 'default'} onClick={openLink} disabled={pending}>
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : kind === 'VIDEO' ? (
              <Play className="size-3.5" />
            ) : (
              <ExternalLink className="size-3.5" />
            )}
            {kind === 'VIDEO' ? (confirmed ? 'Watch again' : 'Watch the video') : 'Open'}
          </Button>
        )}
        {hasNoteOnly && (
          <Button size="sm" variant="outline" onClick={toggleNote} disabled={pending} aria-expanded={expanded}>
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
            )}
            {expanded ? 'Hide' : 'Read it'}
          </Button>
        )}
      </div>
      {hasNoteOnly && expanded && (
        <p className="bg-surface-sunk text-foreground ml-12 rounded-xl px-3.5 py-2.5 text-sm whitespace-pre-wrap">{note}</p>
      )}
    </li>
  )
}
