'use client'

import { useActionState, useState } from 'react'
import { GraduationCap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { createCoachingNoteAction, type CoachingNoteState } from './actions'

const EMPTY_FIELDS = {
  subjectId: '',
  clientId: '',
  score: '',
  strengths: '',
  improvements: '',
  body: '',
}

export function CoachingDialog({
  closers,
  clients,
}: {
  closers: { id: string; name: string; teamName: string | null }[]
  clients: { id: string; name: string }[]
}) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<'ONE_ON_ONE' | 'CALL_QA'>('ONE_ON_ONE')
  // Controlled fields: a rejected server action must not wipe what was typed.
  const [fields, setFields] = useState(EMPTY_FIELDS)
  const setField = (key: keyof typeof EMPTY_FIELDS) => (value: string) =>
    setFields((prev) => ({ ...prev, [key]: value }))
  const [state, action, pending] = useActionState<CoachingNoteState, FormData>(
    async (prev, formData) => {
      const result = await createCoachingNoteAction(prev, formData)
      if (result.ok) {
        setFields(EMPTY_FIELDS)
        setOpen(false)
      }
      return result
    },
    {},
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm">
            <GraduationCap data-slot="icon" /> New note
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{kind === 'CALL_QA' ? 'Score a call' : 'Log a 1-on-1'}</DialogTitle>
          <DialogDescription>
            The closer sees this note — write it like you would say it in the room.
          </DialogDescription>
        </DialogHeader>

        <div className="bg-surface-sunk grid grid-cols-2 gap-1 rounded-lg p-1 text-sm">
          {(
            [
              ['ONE_ON_ONE', '1-on-1 coaching'],
              ['CALL_QA', 'Call QA'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`rounded-md py-1.5 font-medium transition-colors ${
                kind === k
                  ? 'bg-surface-raised shadow-e1'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <form action={action} className="space-y-4">
          <input type="hidden" name="kind" value={kind} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="coach-subject">Closer</Label>
              <NativeSelect
                id="coach-subject"
                name="subjectId"
                required
                className="w-full"
                value={fields.subjectId}
                onChange={(e) => setField('subjectId')(e.target.value)}
              >
                <option value="">Pick a closer…</option>
                {closers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.teamName ? ` (${c.teamName})` : ''}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {kind === 'CALL_QA' ? (
              <div className="space-y-1.5">
                <Label htmlFor="coach-score">QA score (1–10)</Label>
                <Input
                  id="coach-score"
                  name="score"
                  type="number"
                  min={1}
                  max={10}
                  step={1}
                  required
                  placeholder="e.g. 8"
                  className="tabular-nums"
                  value={fields.score}
                  onChange={(e) => setField('score')(e.target.value)}
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="coach-client">Client (optional)</Label>
                <NativeSelect
                  id="coach-client"
                  name="clientId"
                  className="w-full"
                  value={fields.clientId}
                  onChange={(e) => setField('clientId')(e.target.value)}
                >
                  <option value="">No specific client</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
          </div>
          {kind === 'CALL_QA' && (
            <div className="space-y-1.5">
              <Label htmlFor="coach-client-qa">Client on the call (optional)</Label>
              <NativeSelect
                id="coach-client-qa"
                name="clientId"
                className="w-full"
                value={fields.clientId}
                onChange={(e) => setField('clientId')(e.target.value)}
              >
                <option value="">No specific client</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="coach-strengths">Strengths</Label>
            <Input
              id="coach-strengths"
              name="strengths"
              maxLength={2000}
              placeholder="What worked — keep doing this"
              value={fields.strengths}
              onChange={(e) => setField('strengths')(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="coach-improvements">Improvements</Label>
            <Input
              id="coach-improvements"
              name="improvements"
              maxLength={2000}
              placeholder="The one or two things to change next call"
              value={fields.improvements}
              onChange={(e) => setField('improvements')(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="coach-body">Note</Label>
            <Textarea
              id="coach-body"
              name="body"
              required
              rows={4}
              maxLength={8000}
              placeholder={
                kind === 'CALL_QA'
                  ? 'What happened on the call, and why it earned this score…'
                  : 'What you covered, agreements made, and the follow-up…'
              }
              value={fields.body}
              onChange={(e) => setField('body')(e.target.value)}
            />
          </div>
          {state.error && <p className="text-danger text-sm">{state.error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? 'Saving…' : 'Save note'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
