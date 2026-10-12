# Call Center Calendar v2: build contract

Branch `feat/calendar-planner` (base: `feat/dialer-mode-alerts`). Owner ask
(2026-10-11): the Call Center calendar must work and look like a real
appointment planner: week grid with rep-colored visit blocks, day and month
views, a rep filter, a "to schedule" rail, a scheduler popover with a month
grid and 30-minute time chips, reminders. It is built natively in this repo
from this document; no code, data or design file from any other product is
read or copied.

The one approved exception (owner, 2026-10-12): the two SunOff bridges, CYS
sign-up hand-off and team chat, exactly as `docs/CYS_BRIDGE.md` specifies.
Nothing else crosses.

Keep Dakota's backend (`src/lib/call-center/calendar/*`, model
`CallCenterSlot`, flag `CALL_CENTER_CALENDAR`, reminders 24 h / 3 h, autobook)
and the rules in `config.ts` (90-minute visits, 30-minute steps, starts
9:00–17:30 Pacific, 2 h minimum notice, 5 days ahead, 90-minute rep gap).
Extend the service where this document needs more; never weaken a rule.

## 1. Where it lives

- The Calendar is a **tab inside the Call Center desk**
  (`/call-center?tab=calendar`), rendered through the `CallCenter` screen
  exactly like the Ads tab (server content passed as a slot), so the
  dialer-mode header, the tab strip and the desk styles apply. The current
  standalone page in `calendar-tab.tsx` (bare form + table) is replaced.
- The tab shows only when `calendarEnabled()`.
- Every link inside keeps the base `/call-center?tab=calendar`
  (`&view=week&date=2026-10-12&rep=gatsby`). State lives in the URL; the
  server renders from the database.

## 2. Layout (desk, ≥1024 px)

```
┌ tab strip: Today · All · … · Calendar · Ads ───────────────────────────┐
│ [Day] [Week] [Month]   ‹  Oct 12 – 18, 2026  ›  [Today]   Rep: All ▾   │
│ ┌──────────────────────────────────────────────┐ ┌───────────────────┐ │
│ │      Mon 12  Tue 13  Wed 14  Thu 15 …  Sun 18 │ │ Next 3 hours      │ │
│ │ 8am  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │ │ · 1:00 PM Nate F. │ │
│ │ 9am  ┃Nate Fuller┃                            │ │                   │ │
│ │      ┃Gatsby·HOLD┃                            │ │ To schedule (6)   │ │
│ │10am  ┃          ┃   ┏Mara E.━━┓               │ │ · Mara Ellison    │ │
│ │ …    ━━━━━━━━━━━━━━━━ now ━━━━━━━━━━━━━━━━━━━ │ │ · Owen Briggs     │ │
│ │ 8pm                                          │ │ Follow-ups today  │ │
│ └──────────────────────────────────────────────┘ └───────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

- **Week view** (default on a desk): 7 day columns starting Monday, hour
  rows 8 AM–8 PM Pacific with a faint line every 30 minutes. A visit is a
  block 1.5 rows tall, positioned by its start time, **colored by rep**
  (one fixed color per rep key from the config list: teal, amber, violet,
  rose, sky, lime; the same rep always gets the same color; a legend shows
  rep → color). Block text: lead name (first line), time range and rep
  (second line), status chip. Status looks: HOLD = dashed outline + "Hold",
  CONFIRMED = solid, SAT = solid with ✓, NO_SHOW = red tint, RESCHEDULED /
  CANCELLED = struck through and faded (still visible for 1 day).
- A red **now line** across today's column, with the time at its left.
- Overlapping blocks for the same rep are shown side by side and flagged
  with a small ⚠ (a hold placed against the 90-minute gap rule cannot
  happen; the flag is for legacy data).
- **Day view**: one wide column with the same grid, every block full width
  with more text (lead name, phone last 4, language, rep, status, the
  lead's note snippet). Default on phones.
- **Month view**: a 7×5/6 grid; each day shows up to 3 mini chips (time +
  name, rep color) and "+N more"; click a day → Day view of that day.
- **Rep filter**: chips "All" + one per rep; the URL carries `rep=`.
- **Click a block** → a side panel (desk) or bottom sheet (phone) with the
  lead's name, time, rep, status, language, the lead's last note, buttons:
  **Open lead** (`/call-center?lead=…`), **Confirm** (HOLD only, "on the
  call"), **Outcome** (Sat / No-show / Rescheduled / Cancelled, as
  `recordSlotOutcome`), **Reschedule** (opens the scheduler with this lead,
  records RESCHEDULED on the old slot and holds the new one, linked via
  `rescheduledToId`), **Cancel**.
- **Rail** (desk right column; on a phone, a collapsible section above the
  grid):
  - **Next 3 hours**: visits starting within 3 h, with a "Call" shortcut
    that opens the lead.
  - **To schedule**: Call Center leads that are NEW / WAITING / contacted
    with no active slot (HOLD or CONFIRMED), newest first, each with a
    **Book** button that opens the scheduler for that lead.
  - **Follow-ups**: leads with `nextAttemptAt` in the next 24 h.
- Empty states say what to do ("No visits this week. Book one from To
  schedule or from a lead's Callback outcome.").

## 3. Scheduler (the booking popover)

Opened from: a To-schedule row, Reschedule, and the lead panel's **Book
visit** button in the Call Center lead detail (add it next to the Callback
outcome; it must not change any existing outcome flow).

- Left: a **month mini-grid** (Mon–Sun) for picking the day; days outside
  the allowed window (before 2 h from now, after 5 days ahead) are disabled
  and explained in a one-line hint.
- Right: **30-minute chips** for the chosen day, 9:00 AM → 5:30 PM, built
  from `openSlots` for the chosen rep (chip disabled with a tooltip when the
  rep is busy inside the 90-minute gap, when it is too soon, or when the rep
  is off that day). A rep picker above the chips (default: the rep with the
  most openings that day).
- The lead's zone is Pacific for every lead today; show "Pacific" once.
- **Place hold** saves through `holdSlot`; the result shows inline (ok or
  the server's reason). A second button **Hold and confirm** is available
  only while a call to that lead is live (`useVoice().activeTarget` is that
  lead): it holds and confirms in one go.
- Phone: the scheduler is a bottom sheet; the day grid and chips stack.

## 4. Service additions (`src/lib/call-center/calendar/service.ts`)

- `listSlotsBetween(organizationId, from, to, { repKey? })` → slots with
  lead name (from the lead's events, the way the desk builds names), phone
  last 4, language, status, rep.
- `listToSchedule(organizationId)` and `listFollowUps(organizationId, now)`.
- `rescheduleSlot({ organizationId, slotId, repKey, startsAt, userId })` =
  outcome RESCHEDULED on the old slot + `holdSlot` for the new one, in one
  transaction, linked via `rescheduledToId`.
- Rep colors: `repColor(key)` in `config.ts`, pure, tested.
- Server actions in `actions.ts` take plain arguments (not only FormData)
  and return `{ ok } | { ok: false, reason }` so the UI can show reasons.

## 5. Files

- `src/components/call-center/calendar/*`: `calendar-tab.tsx` (server
  loader + layout), `week-grid.tsx`, `day-grid.tsx`, `month-grid.tsx`,
  `visit-block.tsx`, `visit-panel.tsx`, `scheduler.tsx`, `rail.tsx`,
  `calendar.css` (scoped under `.final-desk.call-center .cal-*`).
- `src/components/call-center/call-center.tsx`: the Calendar tab button
  (already there) renders the slot; the lead panel gets **Book visit**.
- `src/app/(app)/call-center/page.tsx`: pass the calendar slot like the
  Ads slot instead of returning a separate page.
- Tests: pure helpers (grid placement from a start time, overlap pairing,
  month cells, rep colors, scheduler chip availability) and the service
  functions on the test DB following `calendar.test.ts`.

## 6. Verification

- vitest for `src/lib/call-center` and the new component helpers; tsc;
  eslint on touched files.
- Playwright on the local e2e DB with `CALL_CENTER_CALENDAR=true` and
  `PRODIGYFLO_FINAL_DESK=true`: seed three holds via `holdSlot`, then
  screenshots of Week, Day, Month at 1440 and of Day + the scheduler sheet
  at 390; no horizontal overflow; the now line is on today; blocks carry
  the rep color; a hold placed from the scheduler appears on the grid.
- The stray "Close" control that showed in the middle of the old calendar
  page must not exist: no Dialog/Sheet renders without content.
