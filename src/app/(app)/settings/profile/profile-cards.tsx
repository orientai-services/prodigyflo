'use client'

import { useActionState, useEffect, useState } from 'react'
import { AtSign, BadgeCheck, Clock3, Sparkles, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  checkForwardingAction, saveForwardingAction, saveIdentityAction, saveSignatureAction,
  type ProfileState,
} from './actions'

function useToastOn(state: ProfileState) {
  useEffect(() => {
    if (state.ok) toast.success(state.ok)
    if (state.error) toast.error(state.error)
  }, [state])
}

function CardHead({ icon: Icon, title, hint }: { icon: typeof UserRound; title: string; hint: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="bg-brand-soft text-brand grid size-9 shrink-0 place-items-center rounded-lg">
        <Icon className="size-4.5" />
      </div>
      <div>
        <h2 className="font-semibold">{title}</h2>
        <p className="text-muted-foreground text-xs">{hint}</p>
      </div>
    </div>
  )
}

/* ── Identity ─────────────────────────────────────────────── */

export function IdentityCard({
  initial,
}: { initial: { name: string; nickname: string; title: string; phone: string } }) {
  const [state, action, pending] = useActionState<ProfileState, FormData>(saveIdentityAction, {})
  useToastOn(state)

  return (
    <Card>
      <CardContent>
        <form action={action} className="space-y-4">
          <CardHead icon={UserRound} title="Identity" hint="Your name as clients and teammates see it." />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="p-name">Full name</Label>
              <Input id="p-name" name="name" defaultValue={initial.name} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-nick">Nickname <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input id="p-nick" name="nickname" defaultValue={initial.nickname} placeholder="What people actually call you" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-title">Title</Label>
              <Input id="p-title" name="title" defaultValue={initial.title} placeholder="Client Advisor" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-phone">Phone</Label>
              <Input id="p-phone" name="phone" defaultValue={initial.phone} placeholder="(702) 555-0100" />
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={pending}>{pending ? 'Saving…' : 'Save'}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

/* ── Forwarding ───────────────────────────────────────────── */

export function ForwardingCard({
  domain, configured, initial,
}: {
  domain: string
  configured: boolean
  initial: { emailAlias: string; forwardingEmail: string; status: 'none' | 'pending' | 'active' }
}) {
  const [state, action, pending] = useActionState<ProfileState, FormData>(saveForwardingAction, {})
  const [checkState, checkAction, checking] = useActionState<ProfileState, FormData>(() => checkForwardingAction(), {})
  useToastOn(state)
  useToastOn(checkState)

  const statusBadge =
    initial.status === 'active' ? (
      <Badge variant="secondary" className="gap-1"><BadgeCheck className="size-3" /> live</Badge>
    ) : initial.status === 'pending' ? (
      <Badge variant="outline" className="text-warning border-warning/40 gap-1"><Clock3 className="size-3" /> awaiting verification</Badge>
    ) : (
      <Badge variant="outline">not set up</Badge>
    )

  return (
    <Card>
      <CardContent>
        <form action={action} className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <CardHead
              icon={AtSign}
              title="Your company email"
              hint={`A real @${domain} address that lands in your own inbox.`}
            />
            {statusBadge}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="p-alias">Address</Label>
              <div className="flex items-center">
                <Input
                  id="p-alias" name="emailAlias" defaultValue={initial.emailAlias}
                  placeholder="hector" className="rounded-r-none" required
                  pattern="[a-z0-9]([a-z0-9._-]{0,30}[a-z0-9])?"
                  title="Lowercase letters, numbers, dots or dashes"
                />
                <span className="border-input bg-surface-sunk text-muted-foreground flex h-9 items-center rounded-r-md border border-l-0 px-3 text-sm whitespace-nowrap">
                  @{domain}
                </span>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-fwd">Forwards to</Label>
              <Input id="p-fwd" name="forwardingEmail" type="email" defaultValue={initial.forwardingEmail} required />
            </div>
          </div>

          {initial.status === 'pending' && (
            <p className="bg-warn-soft text-warning bg-surface-sunk rounded-md px-3 py-2 text-xs">
              Cloudflare sent a verification email to your inbox. Click its link, then press
              <b> Check status</b> — your address goes live the moment it&apos;s verified.
            </p>
          )}
          {!configured && (
            <p className="text-muted-foreground text-xs">
              Saving stores your choice now; forwarding activates when email routing is switched on
              for this server.
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            {initial.status === 'pending' && configured && (
              <Button type="submit" formAction={checkAction} variant="outline" size="sm" disabled={checking}>
                {checking ? 'Checking…' : 'Check status'}
              </Button>
            )}
            <Button type="submit" size="sm" disabled={pending}>{pending ? 'Saving…' : 'Save'}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

/* ── Signature ────────────────────────────────────────────── */

function buildPreview(opts: {
  style: 'formal' | 'friendly'
  name: string; nickname: string; title: string; phone: string; emailAlias: string
  includePhone: boolean; organizationName: string; domain: string
}): string {
  // Mirrors src/lib/messaging/signature.ts — kept in sync by tests.
  const friendly = opts.style === 'friendly'
  const displayName = friendly && opts.nickname.trim() ? opts.nickname.trim() : opts.name
  const lines: string[] = []
  if (friendly) {
    lines.push(`— ${displayName}`)
    const context = [opts.title.trim(), opts.organizationName].filter(Boolean).join(' · ')
    if (context) lines.push(context)
  } else {
    lines.push(displayName)
    if (opts.title.trim()) lines.push(opts.title.trim())
    lines.push(opts.organizationName)
  }
  if (opts.includePhone && opts.phone.trim()) lines.push(opts.phone.trim())
  if (opts.emailAlias) lines.push(`${opts.emailAlias}@${opts.domain}`)
  return lines.join('\n')
}

export function SignatureCard({
  domain, organizationName, initial,
}: {
  domain: string
  organizationName: string
  initial: {
    name: string; nickname: string; title: string; phone: string; emailAlias: string
    style: 'formal' | 'friendly'; includePhone: boolean
  }
}) {
  const [state, action, pending] = useActionState<ProfileState, FormData>(saveSignatureAction, {})
  useToastOn(state)
  const [style, setStyle] = useState<'formal' | 'friendly'>(initial.style)
  const [includePhone, setIncludePhone] = useState(initial.includePhone)

  const preview = (s: 'formal' | 'friendly') =>
    buildPreview({ ...initial, style: s, includePhone, organizationName, domain })

  return (
    <Card>
      <CardContent>
        <form action={action} className="space-y-4">
          <CardHead
            icon={Sparkles}
            title="Email signature"
            hint="Added to every email you send. Pick the voice that fits how you work."
          />

          <div className="grid gap-3 sm:grid-cols-2">
            {(['formal', 'friendly'] as const).map((s) => (
              <label
                key={s}
                className={`cursor-pointer rounded-lg border p-3 transition-colors ${
                  style === s ? 'border-brand ring-brand/30 ring-2' : 'hover:border-brand/40'
                }`}
              >
                <input
                  type="radio" name="signatureStyle" value={s} checked={style === s}
                  onChange={() => setStyle(s)} className="sr-only"
                />
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-semibold">{s === 'formal' ? 'Professional' : 'Nickname'}</span>
                  {style === s && <Badge variant="secondary">selected</Badge>}
                </div>
                <pre className="text-muted-foreground font-sans text-xs leading-5 whitespace-pre-wrap">
                  {preview(s) || '(fill in your identity above)'}
                </pre>
              </label>
            ))}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              name="signatureIncludePhone"
              checked={includePhone}
              onCheckedChange={(v) => setIncludePhone(v === true)}
            />
            Include my phone number
          </label>

          {!initial.nickname && (
            <p className="text-muted-foreground text-xs">
              Tip: the nickname style uses the nickname from your Identity card — add one there first.
            </p>
          )}

          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={pending}>{pending ? 'Saving…' : 'Save signature'}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
