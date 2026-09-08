'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarClock, Check, Loader2, Plus, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { NativeSelect } from '@/components/ui/native-select'
import {
  addNoteAction,
  completeTaskAction,
  createTaskAction,
  reassignTaskAction,
  reopenTaskAction,
  setTaskDueDateAction,
} from './actions'

type Option = { value: string; label: string }

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-md border px-2 text-sm outline-none focus-visible:ring-3'

async function run(
  router: ReturnType<typeof useRouter>,
  action: () => Promise<{ ok?: boolean; error?: string }>,
  success: string,
) {
  const result = await action()
  if (result.ok) {
    toast.success(success)
    router.refresh()
  } else {
    toast.error(result.error ?? 'Something went wrong.')
  }
}

export function NewTaskForm({ clientId, assignees }: { clientId: string; assignees: Option[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('NORMAL')
  const [assigneeId, setAssigneeId] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [pending, startTransition] = useTransition()

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        New task
      </Button>
    )
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    startTransition(async () => {
      const result = await createTaskAction({
        clientId,
        title,
        description: description || undefined,
        priority: priority as 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT',
        assigneeId: assigneeId || undefined,
        dueAt: dueAt || undefined,
      })
      if (result.ok) {
        toast.success('Task created')
        setOpen(false)
        setTitle('')
        setDescription('')
        setPriority('NORMAL')
        setAssigneeId('')
        setDueAt('')
        router.refresh()
      } else {
        toast.error(result.error ?? 'Could not create the task.')
      }
    })
  }

  return (
    <form onSubmit={submit} className="bg-card grid w-full gap-3 rounded-lg border p-4 sm:grid-cols-2">
      <div className="grid gap-1.5 sm:col-span-2">
        <Label htmlFor="task-title">Title</Label>
        <Input
          id="task-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Call back about the utility bill"
          autoFocus
        />
      </div>
      <div className="grid gap-1.5 sm:col-span-2">
        <Label htmlFor="task-desc">Description (optional)</Label>
        <Textarea id="task-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="task-priority">Priority</Label>
        <NativeSelect id="task-priority" value={priority} onChange={(e) => setPriority(e.target.value)} className={selectClass}>
          <option value="LOW">Low</option>
          <option value="NORMAL">Normal</option>
          <option value="HIGH">High</option>
          <option value="URGENT">Urgent</option>
        </NativeSelect>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="task-due">Follow-up date (optional)</Label>
        <Input id="task-due" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
      </div>
      <div className="grid gap-1.5 sm:col-span-2">
        <Label htmlFor="task-assignee">Assignee</Label>
        <NativeSelect id="task-assignee" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className={selectClass}>
          <option value="">Me</option>
          {assignees.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending || !title.trim()}>
          {pending && <Loader2 className="size-3.5 animate-spin" />}
          Create task
        </Button>
      </div>
    </form>
  )
}

export function TaskControls({
  clientId,
  taskId,
  status,
  assigneeId,
  dueAt,
  assignees,
}: {
  clientId: string
  taskId: string
  status: string
  assigneeId: string
  dueAt: string
  assignees: Option[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [showDue, setShowDue] = useState(false)
  const [due, setDue] = useState(dueAt)

  const completed = status === 'COMPLETED'

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {showDue ? (
        <span className="flex items-center gap-1">
          <Input
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="h-7 w-48 text-xs"
            aria-label="Follow-up date"
          />
          <Button
            size="xs"
            variant="outline"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await run(router, () => setTaskDueDateAction({ clientId, taskId, dueAt: due }), 'Follow-up date saved')
                setShowDue(false)
              })
            }
          >
            Save
          </Button>
        </span>
      ) : (
        <Button size="xs" variant="ghost" onClick={() => setShowDue(true)} title="Set follow-up date">
          <CalendarClock className="size-3" />
          Follow-up
        </Button>
      )}

      <NativeSelect
        value={assigneeId}
        disabled={pending}
        onChange={(e) =>
          startTransition(() =>
            run(router, () => reassignTaskAction({ clientId, taskId, assigneeId: e.target.value }), 'Task reassigned'),
          )
        }
        aria-label="Reassign task"
        className="border-input bg-background h-7 rounded-md border px-1.5 text-xs outline-none"
      >
        {assignees.map((a) => (
          <option key={a.value} value={a.value}>
            {a.label}
          </option>
        ))}
      </NativeSelect>

      {completed ? (
        <Button
          size="xs"
          variant="outline"
          disabled={pending}
          onClick={() =>
            startTransition(() => run(router, () => reopenTaskAction({ clientId, taskId }), 'Task reopened'))
          }
        >
          <RotateCcw className="size-3" />
          Reopen
        </Button>
      ) : (
        <Button
          size="xs"
          disabled={pending}
          onClick={() =>
            startTransition(() => run(router, () => completeTaskAction({ clientId, taskId }), 'Task completed'))
          }
        >
          <Check className="size-3" />
          Done
        </Button>
      )}
    </div>
  )
}

export function NoteForm({ clientId, canInternal }: { clientId: string; canInternal: boolean }) {
  const router = useRouter()
  const [body, setBody] = useState('')
  const [isInternal, setIsInternal] = useState(true)
  const [pending, startTransition] = useTransition()

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    startTransition(async () => {
      const result = await addNoteAction({ clientId, body, isInternal: canInternal ? isInternal : false })
      if (result.ok) {
        toast.success('Note added')
        setBody('')
        router.refresh()
      } else {
        toast.error(result.error ?? 'Could not add the note.')
      }
    })
  }

  return (
    <form onSubmit={submit} className="grid gap-2">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="Add a note…"
        aria-label="New note"
      />
      <div className="flex items-center justify-between gap-2">
        {canInternal ? (
          <label className="text-muted-foreground flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={isInternal}
              onChange={(e) => setIsInternal(e.target.checked)}
              className="accent-primary size-3.5"
            />
            Internal only (hidden from the client)
          </label>
        ) : (
          <span className="text-muted-foreground text-xs">Notes you add are visible to the client.</span>
        )}
        <Button type="submit" size="sm" disabled={pending || !body.trim()}>
          {pending && <Loader2 className="size-3.5 animate-spin" />}
          Add note
        </Button>
      </div>
    </form>
  )
}
