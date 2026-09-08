'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { ArrowRight, Loader2, Plug, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CopyValue } from '../intake/new-source-dialog'
import { connectConnector } from './actions'

export type ConnectTarget = {
  defId: string
  name: string
  glyph: string
  accent: string
}

type Created = { slug: string; secret: string; webhookPath: string }

/**
 * The inbound connect flow: name the connection, confirm, provision an IntakeSource,
 * then reveal the endpoint URL + signing secret exactly once (matching the intake
 * reveal). Reused by the gallery cards and the connector detail page.
 */
export function ConnectButton({
  target,
  size = 'sm',
  variant = 'default',
  label = 'Connect',
  block = false,
}: {
  target: ConnectTarget
  size?: 'sm' | 'xs'
  variant?: 'default' | 'outline'
  label?: string
  block?: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState(target.name)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<Created | null>(null)

  const reset = () => {
    setName(target.name)
    setError(null)
    setCreated(null)
  }

  const webhookUrl =
    created && typeof window !== 'undefined' ? `${window.location.origin}${created.webhookPath}` : ''

  const submit = () => {
    setError(null)
    startTransition(async () => {
      const res = await connectConnector({ defId: target.defId, name: name.trim() })
      if (res.ok) {
        setCreated({ slug: res.slug, secret: res.secret, webhookPath: res.webhookPath })
        toast.success(`${target.name} connected.`)
        router.refresh()
      } else {
        setError(res.error ?? 'Could not connect.')
      }
    })
  }

  return (
    <>
      <Button
        size={size}
        variant={variant}
        className={block ? 'w-full' : undefined}
        onClick={() => setOpen(true)}
      >
        <Plug className="size-3.5" />
        {label}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v)
          if (!v) reset()
        }}
      >
        <DialogContent className="max-w-md">
          {created ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="flex size-7 items-center justify-center rounded-md text-sm"
                    style={{ backgroundColor: `${target.accent}1f`, color: target.accent }}
                  >
                    {target.glyph}
                  </span>
                  {target.name} connected
                </DialogTitle>
                <DialogDescription>
                  Point your source at this endpoint and sign each request with the secret below.
                </DialogDescription>
              </DialogHeader>

              <div className="border-warning/40 bg-warning/10 text-warning flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                <span>
                  This signing secret is shown once and can never be recovered — only rotated. Copy it now
                  and store it somewhere safe.
                </span>
              </div>

              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Webhook URL</Label>
                  <CopyValue value={webhookUrl} label="webhook URL" />
                </div>
                <div>
                  <Label className="text-xs">Signing secret</Label>
                  <CopyValue value={created.secret} label="signing secret" />
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => { setOpen(false); reset() }}>
                  Done
                </Button>
                <Button size="sm" render={<Link href={`/settings/connectors/${target.defId}`} />}>
                  Open connector
                  <ArrowRight className="size-3.5" />
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="flex size-7 items-center justify-center rounded-md text-sm"
                    style={{ backgroundColor: `${target.accent}1f`, color: target.accent }}
                  >
                    {target.glyph}
                  </span>
                  Connect {target.name}
                </DialogTitle>
                <DialogDescription>
                  This creates a signed inbound endpoint. You can rename it and tune the field mapping after.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-1">
                <Label htmlFor={`connect-name-${target.defId}`}>Connection name</Label>
                <Input
                  id={`connect-name-${target.defId}`}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={target.name}
                />
                <p className="text-muted-foreground text-xs">Shown in your intake sources and audit log.</p>
              </div>

              {error && <p className="text-destructive text-xs">{error}</p>}

              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={pending}>
                  Cancel
                </Button>
                <Button size="sm" onClick={submit} disabled={pending || name.trim().length < 2}>
                  {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
                  Connect
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
