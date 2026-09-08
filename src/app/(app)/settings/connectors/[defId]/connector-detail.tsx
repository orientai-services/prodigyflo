'use client'

import { useMemo, useState, useTransition, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { ArrowRight, Beaker, CheckCircle2, ExternalLink, KeyRound, Loader2, Plug, ShieldAlert, TriangleAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CRM_FIELDS } from '@/lib/intake/mapping'
import type { ConnectorUiState } from '@/lib/connectors/credential-logic'
import type { ConnectorCategory, ConnectorDirection, ConnectorAvailability } from '@/lib/connectors/catalog'
import { CopyValue } from '../../intake/new-source-dialog'
import { ConnectButton } from '../connect-dialog'
import { connectOutboundConnector, rotateConnectorSecret, testConnectorMapping, toggleConnector } from '../actions'

export type ConnectorDetailVM = {
  defId: string
  name: string
  tagline: string
  glyph: string
  accent: string
  category: ConnectorCategory
  direction: ConnectorDirection
  availability: ConnectorAvailability
  setup: string[]
  docsUrl: string | null
  inbound: boolean
  /** UI state — 'mock' split out of 'connected' so mock mode is never dressed up as live. */
  state: ConnectorUiState
  instanceId: string | null
  instanceName: string | null
  model: 'intakeSource' | 'connector'
  isEnabled: boolean
  slug: string | null
  webhookPath: string | null
  intakeConfigHref: string | null
  submissionCount: number | null
  healthOk: boolean
  healthDetail: string | null
  lastLabel: string | null
  initialMapping: Record<string, string>
  samplePayload: string
}

type MapResult =
  | { ok: true; mapped: Record<string, string>; missingRequired: string[]; unmappedKeys: string[] }
  | { ok: false; error: string }

/** Enable an outbound service (mock mode) — no dialog, no secret reveal. */
function OutboundEnableButton({ defId, name }: { defId: string; name: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const enable = () => {
    startTransition(async () => {
      const res = await connectOutboundConnector({ defId })
      if (res.ok) {
        toast.success(`${name} enabled in mock mode.`)
        router.refresh()
      } else {
        toast.error(res.error ?? 'Could not enable.')
      }
    })
  }
  return (
    <Button size="sm" className="w-full" onClick={enable} disabled={pending}>
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
      Enable {name}
    </Button>
  )
}

const STATE_META: Record<ConnectorUiState, { label: string; className: string; dot: string }> = {
  available: { label: 'Available', className: 'text-muted-foreground', dot: 'bg-muted-foreground/40' },
  connected: { label: 'Connected', className: 'text-success', dot: 'bg-success' },
  mock: { label: 'Mock mode', className: 'text-warning', dot: 'bg-warning' },
  disabled: { label: 'Disabled', className: 'text-muted-foreground', dot: 'bg-muted-foreground/40' },
  error: { label: 'Error', className: 'text-danger', dot: 'bg-danger' },
  'coming-soon': { label: 'Coming soon', className: 'text-muted-foreground', dot: 'bg-muted-foreground/40' },
}

export function ConnectorDetail({
  vm,
  canManage,
  credentialsSlot,
  importSlot,
}: {
  vm: ConnectorDetailVM
  canManage: boolean
  /** Server-rendered credentials card (wrapped in <StepUpGate scope="vault"> by the page). */
  credentialsSlot?: ReactNode
  /** Server-rendered pull-import card (GoHighLevel API def only). */
  importSlot?: ReactNode
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const provisioned = vm.instanceId != null && vm.state !== 'coming-soon'
  const comingSoon = vm.state === 'coming-soon'
  const stateMeta = STATE_META[vm.state]

  const webhookUrl =
    vm.webhookPath && typeof window !== 'undefined' ? `${window.location.origin}${vm.webhookPath}` : vm.webhookPath ?? ''

  // ── Toggle ──
  const setEnabled = (enabled: boolean) => {
    if (!vm.instanceId) return
    startTransition(async () => {
      const res = await toggleConnector({ instanceId: vm.instanceId!, model: vm.model, enabled, defId: vm.defId })
      if (res.ok) {
        toast.success(enabled ? 'Connector enabled.' : 'Connector disabled — deliveries will 404.')
        router.refresh()
      } else {
        toast.error(res.error ?? 'Could not update.')
      }
    })
  }

  // ── Rotate ──
  const [rotateOpen, setRotateOpen] = useState(false)
  const [rotated, setRotated] = useState<string | null>(null)
  const rotate = () => {
    if (!vm.instanceId) return
    startTransition(async () => {
      const res = await rotateConnectorSecret({ sourceId: vm.instanceId!, defId: vm.defId })
      if (res.ok && 'secret' in res && res.secret) {
        setRotated(res.secret)
        router.refresh()
      } else {
        toast.error(('error' in res && res.error) || 'Could not rotate the secret.')
        setRotateOpen(false)
      }
    })
  }

  // ── Mapping tester ──
  const [payload, setPayload] = useState(vm.samplePayload)
  const [result, setResult] = useState<MapResult | null>(null)
  const [testing, setTesting] = useState(false)

  const mappedFieldKeys = useMemo(
    () => (result && result.ok ? new Set(Object.keys(result.mapped)) : new Set<string>()),
    [result],
  )

  const runTest = () => {
    setTesting(true)
    startTransition(async () => {
      const res = await testConnectorMapping({ defId: vm.defId, fieldMapping: vm.initialMapping, payloadJson: payload })
      setResult(res)
      setTesting(false)
    })
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* ── Overview ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className="flex size-8 items-center justify-center rounded-lg text-base"
                style={{ backgroundColor: `${vm.accent}1f`, color: vm.accent }}
              >
                {vm.glyph}
              </span>
              {vm.name}
            </span>
            <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${stateMeta.className}`}>
              <span className={`size-1.5 rounded-full ${stateMeta.dot}`} />
              {stateMeta.label}
            </span>
          </CardTitle>
          <CardDescription>{vm.tagline}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="outline">{vm.category}</Badge>
            <Badge variant="outline">{vm.direction === 'inbound' ? 'Inbound' : vm.direction === 'outbound' ? 'Outbound' : 'Two-way'}</Badge>
            {vm.docsUrl && (
              <a
                href={vm.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                Docs <ExternalLink className="size-3" />
              </a>
            )}
          </div>

          {provisioned ? (
            <div className="space-y-2 border-t pt-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{vm.instanceName}</span>
                {canManage && vm.instanceId && (
                  <label className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">{vm.isEnabled ? 'Enabled' : 'Disabled'}</span>
                    <Switch checked={vm.isEnabled} disabled={pending} onCheckedChange={setEnabled} />
                  </label>
                )}
              </div>
              <div className="text-muted-foreground grid grid-cols-2 gap-3 text-xs">
                <div>
                  <div className="tabular-nums text-foreground text-lg font-semibold">{vm.submissionCount ?? 0}</div>
                  <div>Submissions</div>
                </div>
                <div>
                  <div className="text-foreground flex items-center gap-1.5 text-sm font-medium">
                    {vm.healthOk ? (
                      <CheckCircle2 className="text-success size-4" />
                    ) : (
                      <TriangleAlert className="text-danger size-4" />
                    )}
                    {vm.healthOk ? 'Healthy' : 'Attention'}
                  </div>
                  <div>{vm.lastLabel ? `Last activity ${vm.lastLabel}` : 'No activity yet'}</div>
                </div>
              </div>
              {vm.state === 'error' && vm.healthDetail && (
                <p className="text-danger text-xs">{vm.healthDetail}</p>
              )}
            </div>
          ) : comingSoon ? (
            <div className="border-t pt-3">
              <div className="text-muted-foreground flex items-start gap-2 text-sm">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                <span>This connector is staged. It needs credentials before it can go live — see requirements below.</span>
              </div>
            </div>
          ) : (
            <div className="space-y-3 border-t pt-3">
              <p className="text-muted-foreground text-sm">
                {vm.model === 'connector'
                  ? 'Not enabled yet. Enabling starts this service in mock mode — add credentials to go live.'
                  : 'Not connected yet. Connecting mints a signed inbound endpoint.'}
              </p>
              {canManage &&
                (vm.model === 'connector' ? (
                  <OutboundEnableButton defId={vm.defId} name={vm.name} />
                ) : (
                  <ConnectButton
                    target={{ defId: vm.defId, name: vm.name, glyph: vm.glyph, accent: vm.accent }}
                    label={`Connect ${vm.name}`}
                    block
                  />
                ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Credential vault (outbound defs; step-up gated server-side) ── */}
      {credentialsSlot}

      {/* ── Pull import (GoHighLevel API def) ── */}
      {importSlot}

      {/* ── Setup steps ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{comingSoon ? 'Requirements' : 'Setup'}</CardTitle>
          <CardDescription>
            {comingSoon ? 'What this connector needs before it can be enabled.' : `Wire ${vm.name} up in a few steps.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3">
            {vm.setup.map((step, i) => (
              <li key={i} className="flex gap-3 text-sm">
                <span className="bg-muted text-muted-foreground flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums">
                  {i + 1}
                </span>
                <span className="text-muted-foreground leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {/* ── Delivery / endpoint (provisioned inbound only) ── */}
      {provisioned && vm.inbound && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Endpoint & secret</CardTitle>
            <CardDescription>
              Send a JSON POST signed with{' '}
              <code className="text-xs">X-Intake-Signature: sha256=HMAC_SHA256(sha256_hex(secret), raw body)</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-xs">Webhook URL</Label>
              <CopyValue value={webhookUrl} label="webhook URL" />
            </div>
            {canManage && (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setRotateOpen(true)} disabled={pending}>
                  <KeyRound className="size-3.5" />
                  Rotate secret
                </Button>
                {vm.intakeConfigHref && (
                  <Button variant="outline" size="sm" render={<Link href={vm.intakeConfigHref} />}>
                    Field mapping & advanced
                    <ArrowRight className="size-3.5" />
                  </Button>
                )}
              </div>
            )}
            {!canManage && vm.intakeConfigHref && (
              <Button variant="outline" size="sm" render={<Link href={vm.intakeConfigHref} />}>
                View field mapping
                <ArrowRight className="size-3.5" />
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Live mapping tester (inbound defs) ── */}
      {vm.inbound && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Beaker className="size-4" />
              Live mapping tester
            </CardTitle>
            <CardDescription>
              Paste a real payload to preview exactly which CRM fields it fills — before it goes live. Uses the
              current field mapping.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              placeholder='{"first_name": "Ada", "email": "ada@example.com"}'
              className="h-40 font-mono text-xs"
              aria-label="Sample payload"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={runTest} disabled={testing || pending || !payload.trim()}>
                {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Beaker className="size-3.5" />}
                Test mapping
              </Button>
              {result && !result.ok && <span className="text-destructive text-xs">{result.error}</span>}
            </div>

            {result && result.ok && (
              <div className="space-y-3">
                {result.missingRequired.length > 0 ? (
                  <div className="border-danger/40 bg-danger/10 text-danger flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    <span>Missing required: {result.missingRequired.join(', ')} — this payload would not create a lead.</span>
                  </div>
                ) : (
                  <div className="border-success/40 bg-success/10 text-success flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                    <span>All required fields present — this payload would create a lead.</span>
                  </div>
                )}

                <div className="divide-border overflow-hidden rounded-md border">
                  {CRM_FIELDS.map((field) => {
                    const value = result.mapped[field.key]
                    const has = mappedFieldKeys.has(field.key)
                    return (
                      <div key={field.key} className="flex items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0">
                        <span className="w-28 shrink-0 font-medium">
                          {field.label}
                          {'required' in field && field.required && <span className="text-destructive">*</span>}
                        </span>
                        {has ? (
                          <span className="text-success min-w-0 flex-1 truncate font-mono" title={value}>
                            {value}
                          </span>
                        ) : (
                          <span className="text-muted-foreground min-w-0 flex-1 truncate italic">— empty</span>
                        )}
                      </div>
                    )
                  })}
                </div>

                {result.unmappedKeys.length > 0 && (
                  <div>
                    <Label className="text-muted-foreground text-xs">
                      Unmapped keys ({result.unmappedKeys.length}) — present in the payload but not wired to a field
                    </Label>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {result.unmappedKeys.map((k) => (
                        <code key={k} className="bg-muted rounded px-1.5 py-0.5 font-mono text-[0.6875rem]">
                          {k}
                        </code>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Rotate confirm/reveal dialog ── */}
      <Dialog
        open={rotateOpen}
        onOpenChange={(v) => {
          setRotateOpen(v)
          if (!v) setRotated(null)
        }}
      >
        <DialogContent className="max-w-md">
          {rotated ? (
            <>
              <DialogHeader>
                <DialogTitle>New signing secret</DialogTitle>
                <DialogDescription>
                  Shown once. Update every caller — requests signed with the old secret are now rejected.
                </DialogDescription>
              </DialogHeader>
              <CopyValue value={rotated} label="signing secret" />
              <DialogFooter>
                <Button size="sm" onClick={() => { setRotateOpen(false); setRotated(null) }}>
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Rotate signing secret?</DialogTitle>
                <DialogDescription>
                  The current secret stops working immediately, and deliveries signed with it fail with 401 until
                  callers are updated.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => setRotateOpen(false)} disabled={pending}>
                  Cancel
                </Button>
                <Button variant="destructive" size="sm" onClick={rotate} disabled={pending}>
                  {pending && <Loader2 className="size-3.5 animate-spin" />}
                  Rotate
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
