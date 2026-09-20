'use client'

import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { civilDate, timeLabel, missingDocsLabel, type DeskBoard, type DeskChip, type DeskLead } from '@/lib/daily-desk'
import { assignDeskCloserAction, bookAppointmentAction, markNoShowAction } from './actions'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type MenuState = {
  startsAt?: string
  appointmentId?: string
  status?: string
  clientId: string
  x: number
  y: number
  name: string
  email: string
  phone: string
  ownerName: string | null
}

export function DeskCalendar({
  board,
  prevHref,
  nextHref,
  todayHref,
}: {
  board: DeskBoard
  prevHref: string
  nextHref: string
  todayHref: string
}) {
  const router = useRouter()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [assignId, setAssignId] = useState<string | null>(null)
  const [bookId, setBookId] = useState<string | null>(null)
  const [bookAppointmentId, setBookAppointmentId] = useState<string | undefined>()
  const [bookDate, setBookDate] = useState(board.today)
  const [bookTime, setBookTime] = useState('10:00')
  const [closerId, setCloserId] = useState(board.closers[0]?.id ?? '')
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [dragging, setDragging] = useState<DeskLead | null>(null)

  const leads = useMemo(() => new Map(board.unscheduled.map((l) => [l.clientId, l])), [board.unscheduled])
  const chips = useMemo(() => {
    const map = new Map<string, DeskChip>()
    for (const day of board.days) {
      for (const chip of day.chips) map.set(chip.clientId, chip)
    }
    return map
  }, [board.days])

  const closeMenu = () => setMenu(null)

  const openProfile = (clientId: string) => {
    closeMenu()
    router.push(`/clients/${clientId}`)
  }

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null)
    const over = event.over?.id ? String(event.over.id) : ''
    const active = String(event.active.id)
    if (!over.startsWith('day:') || !active.startsWith('lead:')) return
    const date = over.slice(4)
    const clientId = active.slice(5)
    if (!board.canBook) {
      toast.error('You cannot book appointments.')
      return
    }
    void runBook(clientId, date, '10:00')
  }

  async function runBook(clientId: string, date: string, time: string, appointmentId?: string) {
    setPending(true)
    const result = await bookAppointmentAction({ clientId, date, time, appointmentId, timezone: board.timezone })
    setPending(false)
    if (result.ok) {
      toast.success('Appointment saved.')
      setBookId(null)
      router.refresh()
    } else {
      toast.error(result.error ?? 'Could not book.')
    }
  }

  async function runAssign() {
    if (!assignId || !closerId) return
    setPending(true)
    const result = await assignDeskCloserAction({
      clientId: assignId,
      closerId,
      note: note.trim() || undefined,
    })
    setPending(false)
    if (result.ok) {
      toast.success('Closer assigned.')
      setAssignId(null)
      setNote('')
      router.refresh()
    } else {
      toast.error(result.error ?? 'Could not assign.')
    }
  }

  async function runNoShow(clientId: string, appointmentId: string) {
    closeMenu()
    setPending(true)
    const result = await markNoShowAction({ clientId, appointmentId })
    setPending(false)
    if (result.ok) {
      toast.success('Marked no-show.')
      router.refresh()
    } else {
      toast.error(result.error ?? 'Could not mark no-show.')
    }
  }

  function copyContact(item: { email: string; phone: string; name: string }) {
    closeMenu()
    const text = [item.name, item.email, item.phone].filter(Boolean).join('\n')
    void navigator.clipboard.writeText(text).then(
      () => toast.success('Contact copied.'),
      () => toast.error('Could not copy.'),
    )
  }

  const assignTarget = assignId ? (chips.get(assignId) ?? leads.get(assignId)) : null
  const bookTarget = bookId ? (chips.get(bookId) ?? leads.get(bookId)) : null

  return (
    <div className="desk-page">
      {board.unassignedCount > 0 && (
        <div className="desk-banner">
          {board.unassignedCount} unassigned lead{board.unassignedCount === 1 ? '' : 's'}.
          Assign from the calendar. Dollar tiles stay on Pipeline.
        </div>
      )}

      <DndContext
        id="desk-board"
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={(e) => {
          const id = String(e.active.id)
          if (id.startsWith('lead:')) setDragging(leads.get(id.slice(5)) ?? null)
        }}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <div className="desk-board">
          <section className="desk-card">
            <div className="desk-cal-head">
              <h2 className="font-heading">{board.title} <small>{board.timezone}</small></h2>
              <div className="desk-cal-nav">
                <Link href={prevHref} className="desk-btn-secondary">
                  Prev
                </Link>
                <Link href={todayHref} className="desk-btn-secondary">
                  Today
                </Link>
                <Link href={nextHref} className="desk-btn-secondary">
                  Next
                </Link>
              </div>
            </div>
            <div className="desk-week">
              {WEEKDAYS.map((d) => (
                <span key={d}>{d}</span>
              ))}
            </div>
            <div className="desk-days">
              {board.days.map((day) => (
                <DayCell
                  key={day.iso}
                  iso={day.iso}
                  day={day.day}
                  inMonth={day.inMonth}
                  isToday={day.isToday}
                  canDrop={board.canBook && day.inMonth}
                >
                  {day.chips.map((chip) => (
                    <Chip
                      key={chip.appointmentId}
                      chip={chip}
                      onOpen={() => openProfile(chip.clientId)}
                      onMenu={(event) => {
                        event.preventDefault()
                        setMenu({
                          clientId: chip.clientId,
                          appointmentId: chip.appointmentId,
                          status: chip.status,
                          startsAt: chip.startsAt,
                          x: event.clientX,
                          y: event.clientY,
                          name: `${chip.firstName} ${chip.lastName}`,
                          email: chip.email,
                          phone: chip.phone,
                          ownerName: chip.ownerName,
                        })
                      }}
                    />
                  ))}
                </DayCell>
              ))}
            </div>
          </section>

          <aside className="desk-card desk-side">
            <h3>Unscheduled</h3>
            <p className="desk-muted">
              {board.canBook ? 'Drag onto a day or click the file.' : 'Click a file to open it.'}
            </p>
            {board.unscheduled.length === 0 && <p className="desk-muted">All active clients have an upcoming appointment.</p>}
            {board.unscheduled.map((lead) => (
              <UnscheduledLead
                key={lead.clientId}
                lead={lead}
                canDrag={board.canBook}
                onOpen={() => openProfile(lead.clientId)}
                onMenu={(event) => {
                  event.preventDefault()
                  setMenu({
                    clientId: lead.clientId,
                    x: event.clientX,
                    y: event.clientY,
                    name: `${lead.firstName} ${lead.lastName}`,
                    email: lead.email,
                    phone: lead.phone,
                    ownerName: lead.ownerName,
                  })
                }}
              />
            ))}
          </aside>
        </div>

        <DragOverlay dropAnimation={null}>
          {dragging && (
            <div className="desk-lead dragging">
              <b>
                {dragging.firstName} {dragging.lastName}
              </b>
              <span>{missingDocsLabel(dragging.missingDocs)}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {menu && (
        <div
          className="desk-menu"
          style={{ top: menu.y, left: menu.x }}
          role="menu"
        >
          <button type="button" onClick={() => openProfile(menu.clientId)}>
            View profile
          </button>
          {board.canAssign && (
            <button
              type="button"
              onClick={() => {
                setCloserId(board.closers[0]?.id ?? '')
                setAssignId(menu.clientId)
                closeMenu()
              }}
            >
              Assign closer
            </button>
          )}
          {board.canBook && (!menu.appointmentId || ['SCHEDULED', 'CONFIRMED'].includes(menu.status ?? '')) && (
            <button
              type="button"
              onClick={() => {
                setBookDate(menu.startsAt ? civilDate(new Date(menu.startsAt), board.timezone) : board.today)
                setBookTime(menu.startsAt ? timeLabel(new Date(menu.startsAt), board.timezone) : '10:00')
                setBookId(menu.clientId)
                setBookAppointmentId(menu.appointmentId)
                closeMenu()
              }}
            >
              {menu.appointmentId ? 'Reschedule' : 'Book'}
            </button>
          )}
          <button type="button" onClick={() => copyContact(menu)}>
            Copy contact
          </button>
          {board.canBook && menu.appointmentId && ['SCHEDULED', 'CONFIRMED'].includes(menu.status ?? '') && (
            <button type="button" onClick={() => void runNoShow(menu.clientId, menu.appointmentId!)}>
              Mark no-show
            </button>
          )}
        </div>
      )}
      {menu && <button type="button" className="desk-menu-backdrop" aria-label="Close menu" onClick={closeMenu} />}

      <Dialog open={assignId !== null} onOpenChange={(open) => !open && setAssignId(null)}>
        <DialogContent className="desk-dialog sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Assign closer</DialogTitle>
          </DialogHeader>
          <p className="desk-muted">
            {assignTarget ? `${assignTarget.firstName} ${assignTarget.lastName}` : ''}
          </p>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="desk-closer">Closer</Label>
              <NativeSelect
                id="desk-closer"
                className="w-full"
                value={closerId}
                onChange={(e) => setCloserId(e.target.value)}
              >
                {board.closers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="desk-note">Optional note</Label>
              <Textarea id="desk-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignId(null)}>
              Cancel
            </Button>
            <Button disabled={pending || !closerId} onClick={() => void runAssign()}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bookId !== null} onOpenChange={(open) => !open && setBookId(null)}>
        <DialogContent className="desk-dialog sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Book / reschedule</DialogTitle>
          </DialogHeader>
          <p className="desk-muted">
            {bookTarget ? `${bookTarget.firstName} ${bookTarget.lastName}` : ''}
          </p>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="desk-date">Date</Label>
              <Input id="desk-date" type="date" value={bookDate} onChange={(e) => setBookDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="desk-time">Time</Label>
              <Input id="desk-time" type="time" value={bookTime} onChange={(e) => setBookTime(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBookId(null)}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() => bookId && void runBook(bookId, bookDate, bookTime || '10:00', bookAppointmentId)}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function DayCell({
  iso,
  day,
  inMonth,
  isToday,
  canDrop,
  children,
}: {
  iso: string
  day: number
  inMonth: boolean
  isToday: boolean
  canDrop: boolean
  children: ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${iso}`, disabled: !canDrop })
  return (
    <div
      ref={setNodeRef}
      className={cn('desk-day', !inMonth && 'mute', isToday && 'today', isOver && canDrop && 'drop')}
    >
      <span className="num">{day}</span>
      {children}
    </div>
  )
}

function Chip({
  chip,
  onOpen,
  onMenu,
}: {
  chip: DeskChip
  onOpen: () => void
  onMenu: (event: MouseEvent) => void
}) {
  return (
    <button
      type="button"
      className={cn('desk-chip', !chip.ownerName && 'unassigned')}
      onClick={onOpen}
      onContextMenu={onMenu}
    >
      <b>
        {chip.timeLabel} {chip.firstName}
      </b>
      {chip.ownerName ?? 'Unassigned'}
      {!['SCHEDULED', 'CONFIRMED'].includes(chip.status) && <span>{chip.status.replaceAll('_', ' ').toLowerCase()}</span>}
      <span className="desk-chip-meta">{missingDocsLabel(chip.missingDocs)}</span>
    </button>
  )
}

function UnscheduledLead({
  lead,
  canDrag,
  onOpen,
  onMenu,
}: {
  lead: DeskLead
  canDrag: boolean
  onOpen: () => void
  onMenu: (event: MouseEvent) => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `lead:${lead.clientId}`,
    disabled: !canDrag,
  })
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={cn('desk-lead', isDragging && 'dragging')}
      onClick={onOpen}
      onContextMenu={onMenu}
      {...(canDrag ? { ...attributes, ...listeners } : {})}
    >
      <b>
        {lead.firstName} {lead.lastName}
      </b>
      <span>
        {lead.ownerName ?? 'Unassigned'} · {missingDocsLabel(lead.missingDocs)}
      </span>
    </button>
  )
}
