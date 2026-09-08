'use client'

import { useActionState, useState } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { updateCloseOpsAction, type OpsConfigState } from './actions'

type PhaseOption = { phase: number; name: string; hotLeadThreshold: number }

export function OpsSettings({
  config,
  phases,
}: {
  config: { phase: number; hotLeadThreshold: number; leakageDays: number }
  phases: PhaseOption[]
}) {
  return (
    <div className="bg-card shadow-e1 rounded-xl border">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Operations settings</h2>
        <p className="text-muted-foreground text-xs">
          Org-wide levers — every dashboard, queue, and leakage number follows them
        </p>
      </div>
      <div className="grid gap-4 p-4 lg:grid-cols-3">
        <PhaseSwitcher config={config} phases={phases} />
        <TuningForm
          title="Hot-lead threshold"
          description="Minimum AI probability for the call queue. Switching phase resets it to the phase default."
          name="hotLeadThreshold"
          min={50}
          max={100}
          unit="%"
          current={config.hotLeadThreshold}
        />
        <TuningForm
          title="Leakage window"
          description="Days a live lead can sit with no activity before it counts as leaking."
          name="leakageDays"
          min={1}
          max={30}
          unit="days"
          current={config.leakageDays}
        />
      </div>
    </div>
  )
}

function PhaseSwitcher({ config, phases }: { config: { phase: number }; phases: PhaseOption[] }) {
  const [selected, setSelected] = useState(String(config.phase))
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [state, action, pending] = useActionState<OpsConfigState, FormData>(
    async (prev, formData) => {
      const result = await updateCloseOpsAction(prev, formData)
      if (result.ok) setConfirmOpen(false)
      return result
    },
    {},
  )

  const target = phases.find((p) => String(p.phase) === selected)
  const dirty = selected !== String(config.phase)

  return (
    <div className="bg-surface-sunk/50 rounded-lg border p-3">
      <p className="text-sm font-medium">Operating phase</p>
      <p className="text-muted-foreground mt-0.5 text-xs">
        Sets the targets and the default hot-lead threshold for everyone.
      </p>
      <div className="mt-2.5 space-y-2">
        <NativeSelect
          aria-label="Operating phase"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="w-full"
        >
          {phases.map((p) => (
            <option key={p.phase} value={String(p.phase)}>
              Phase {p.phase} — {p.name}
            </option>
          ))}
        </NativeSelect>
        <Button
          type="button"
          size="sm"
          className="w-full"
          disabled={!dirty}
          onClick={() => setConfirmOpen(true)}
        >
          {dirty ? 'Switch phase…' : 'Current phase'}
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Switch to Phase {target?.phase}?</DialogTitle>
            <DialogDescription>
              This changes thresholds org-wide. Every closer&rsquo;s hot-lead queue, the phase
              scoreboard, and the dashboard targets move with it immediately.
            </DialogDescription>
          </DialogHeader>
          {target && (
            <div className="bg-surface-sunk rounded-lg border p-3 text-sm">
              <p className="flex items-center gap-2 font-medium">
                Phase {config.phase} <ArrowRight className="text-muted-foreground size-3.5" /> Phase{' '}
                {target.phase}
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                {target.name} — hot-lead threshold resets to {target.hotLeadThreshold}% unless you pin
                one afterwards.
              </p>
            </div>
          )}
          {state.error && <p className="text-danger text-sm">{state.error}</p>}
          <form action={action} className="flex justify-end gap-2">
            <input type="hidden" name="phase" value={selected} />
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? 'Switching…' : `Switch to Phase ${target?.phase}`}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function TuningForm({
  title,
  description,
  name,
  min,
  max,
  unit,
  current,
}: {
  title: string
  description: string
  name: string
  min: number
  max: number
  unit: string
  current: number
}) {
  const [state, action, pending] = useActionState<OpsConfigState, FormData>(updateCloseOpsAction, {})

  return (
    <form action={action} className="bg-surface-sunk/50 rounded-lg border p-3">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
      <div className="mt-2.5 flex items-center gap-2">
        <Label htmlFor={`ops-${name}`} className="sr-only">
          {title}
        </Label>
        <Input
          id={`ops-${name}`}
          name={name}
          type="number"
          min={min}
          max={max}
          step={1}
          defaultValue={current}
          required
          className="w-24 tabular-nums"
        />
        <span className="text-muted-foreground text-xs">{unit}</span>
        <Button type="submit" size="sm" variant="outline" disabled={pending} className="ml-auto">
          {pending ? 'Saving…' : state.ok ? <><Check data-slot="icon" /> Saved</> : 'Save'}
        </Button>
      </div>
      <p className="text-muted-foreground mt-1.5 text-xs tabular-nums">
        Allowed {min}–{max} {unit} · currently {current} {unit}
      </p>
      {state.error && <p className="text-danger mt-1.5 text-xs">{state.error}</p>}
    </form>
  )
}
