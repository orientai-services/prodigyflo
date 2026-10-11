import Link from 'next/link'
import '../../final-desk/final-desk.css'
import '../call-center.css'
import { calendarReps } from '@/lib/call-center/calendar/config'
import { formatVisitTime } from '@/lib/call-center/calendar/copy'
import { confirmCalendarSlot, holdCalendarSlot, saveCalendarOutcome } from '@/lib/call-center/calendar/actions'
import { listCalendarSlots, listOpenSlots } from '@/lib/call-center/calendar/service'

/**
 * Call Center Calendar tab (/call-center?tab=calendar). Door 2 leads only.
 * Separate from the Master Calendar. A slot is a HOLD until the rep confirms on the call.
 */
export async function CallCenterCalendarTab({ organizationId, leadId }: { organizationId: string; leadId: string | null }) {
  const [open, slots] = await Promise.all([listOpenSlots(organizationId), listCalendarSlots(organizationId)])
  const reps = new Map(calendarReps().map((r) => [r.key, r.label]))
  return (
    // The desk styles are scoped to `.final-desk.call-center` (see call-center.tsx), so the
    // tab renders inside the same wrapper or it shows up as raw unstyled text.
    <div className="final-desk call-center">
      <main className="main">
      <p>
        <Link href="/call-center">← Back to the desk</Link>
      </p>
      <div className="page-title">
        <h2>Call Center Calendar</h2>
        <p className="muted">In-home visits, 90 minutes. Times are Pacific. A hold is not a booking until the rep confirms on the call.</p>
      </div>

      <div className="card block">
      <form action={holdCalendarSlot} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'end' }}>
        <label>
          Lead id <input name="leadId" defaultValue={leadId ?? ''} required />
        </label>
        <label>
          Slot{' '}
          <select name="slot" required>
            {open.slice(0, 120).map((s) => (
              <option key={`${s.repKey}|${s.startsAt.toISOString()}`} value={`${s.repKey}|${s.startsAt.toISOString()}`}>
                {formatVisitTime(s.startsAt, 'EN')} · {reps.get(s.repKey) ?? s.repKey}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn">Place hold</button>
      </form>
      </div>

      <div className="card lead-table" style={{ marginTop: 16 }}>
      <table>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Rep</th>
            <th scope="col">Lead</th>
            <th scope="col">Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {slots.map((s) => (
            <tr key={s.id}>
              <td>{formatVisitTime(s.startsAt, 'EN')}</td>
              <td>{reps.get(s.repKey) ?? s.repKey}</td>
              <td>
                <Link href={`/call-center?lead=${encodeURIComponent(s.leadId)}`}>Open lead</Link>
              </td>
              <td>{s.status}</td>
              <td>
                {s.status === 'HOLD' ? (
                  <form action={confirmCalendarSlot}>
                    <input type="hidden" name="slotId" value={s.id} />
                    <button type="submit" className="btn">Confirm (on the call)</button>
                  </form>
                ) : null}
                {s.status === 'HOLD' || s.status === 'CONFIRMED' ? (
                  <form action={saveCalendarOutcome}>
                    <input type="hidden" name="slotId" value={s.id} />
                    <select name="outcome" defaultValue="sat">
                      {s.status === 'CONFIRMED' ? <option value="sat">Sat</option> : null}
                      {s.status === 'CONFIRMED' ? <option value="no-show">No-show</option> : null}
                      <option value="rescheduled">Rescheduled</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                    <button type="submit" className="btn secondary">Save outcome</button>
                  </form>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!slots.length ? <p className="block muted">No holds or visits yet.</p> : null}
      </div>
      </main>
    </div>
  )
}
