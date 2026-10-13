# Dialer app: build contract

Owner ask (2026-10-12): the Call Center ("dialer mode") becomes a full,
app-style dialer that a rep can run the whole day from a phone or a desk:
Today, Messages, Leads, Booked, History, More. Built natively in this repo
from this document; no code, data, design file or credential from any other
product is read or copied.

The one approved exception (owner, 2026-10-12): the two SunOff bridges, CYS
sign-up hand-off and team chat, exactly as `docs/CYS_BRIDGE.md` specifies.
Nothing else crosses.

Everything already shipped stays and is reused: the desk lead list and lead
panel, power mode, cadence, callbacks, missed calls, the dial pad
(`docs/DIAL_PAD.md`), the calendar planner (`docs/CALENDAR.md`), the Ads
dashboard (`docs/META_ADS_SCS.md`), the phone status pill + settings sheet
(feat/phone-pill), browser calling and recordings (`docs/TELEPHONY_LIVE.md`).
Compliance rules are unchanged: the server decides every dial and every text.
Full phone numbers reach the browser only for viewers allowed to see them
(§Phone numbers); everyone else gets the last 4.

## 1. Shell (lane A)

Route stays `/call-center`; the section is `?s=today|messages|leads|booked|history`
(default `today`), deep links keep working (`?lead=`, `?missed=`,
`?tab=ads|calendar` map to `s=leads`+ads view / `s=booked`).

- **Header** (all widths, sticky): brand mark, the section title in the
  display serif ("Today", "Messages", …), then on the right the **phone status
  pill** (from feat/phone-pill) and a prominent **Dialer** button (phone icon +
  "Dialer", filled teal) that opens the dial pad. The Dialer-mode switch moves
  into More (and stays in the desk rail on the other pages). Search lives in
  Leads/History/Messages where it filters that section, not in the header.
- **Bottom tab bar** below 1024 px: Today, Messages, Leads, Booked, History,
  More. Icon + label, 56 px tall + safe area, active tab in the brand teal,
  badges: Today = follow-ups due + new not contacted, Messages = unread
  inbound. The page gets bottom padding for it; the in-call dock and power bar
  sit above it (`--voice-dock-h` + the bar height); sheets cover it.
- **Desktop ≥1024**: the same six sections as a top section strip under the
  header (no left rail). Content max-width 1280, centred.
- **More** (bottom sheet on phones, popover on desktop): Campaigns (the Ads
  dashboard), Team, Calendar settings link if any, a status block (green
  "Live" dot + "Updated N min ago" from the desk refresh; "Connected" phone
  chip from the pill state; "Office · (725) 888-8560" = the user's default
  caller line, formatted; the user's name and role), **Settings** (opens the
  phone settings sheet), **Dialer mode** switch (off → `/board`).
- **Team** (inside More, its own view `?s=team`): every active user of the
  workspace with presence (ready in the last 2 min = green), calls today,
  talk time today, booked today, last activity time. Read from VoiceCall,
  CallCenterEvent, CallCenterSlot, VoicePresence. Super Admin sees everyone;
  a Closer sees the same list (no phone numbers anywhere).

## 2. Today (lane A)

- Date line ("Monday, October 12", Pacific).
- 4 KPI tiles: **Not contacted** ("call these first"), **Follow-ups today**
  ("due today or overdue"), **Booked** ("visits this week" with count of
  CONFIRMED + HOLD from CallCenterSlot), **Confirmed today** ("confirmed on the
  call"). Each tile is a button that opens the matching filtered list.
- A one-paragraph plain-words explainer card (dismissible, remembered per
  browser): "This is your call list for the day. When someone fills out the
  ad's form, the faster you call, the easier the sale. The ones waiting
  longest are at the top."
- **Team activity today**: count + a compact feed of today's calls, outcomes,
  holds/confirmations and texts across the team ("Gatsby called Nate F. ·
  2:14 · answered", "Hector booked Mara E. for Thu 9:00"). Empty: "Nobody has
  done anything yet today."
- **What to attack first** (the existing priority ranking, top 10): numbered
  rows with the lead name (link opens the lead), one-line reason (the existing
  *why*), stage chip (NEW / WAITING / CALLBACK / BOOKED …), assigned or
  locking rep, appointment time when booked, last contact ("☎ 4 d ago"), the
  lead's main issue/note snippet when present, a **Call** button (the existing
  checkDial → voice.call flow) and **▶ Listen · m:ss · N d ago** when the lead
  has a recorded call (uses the existing recording player/route). A lead whose
  number is invalid or missing shows a red **Invalid number** chip instead of
  an enabled Call. "updates by itself" note (the 20 s refresh).

## 3. History (lane B)

Server loader `loadHistory(user, { filter, q, cursor })` in
`src/lib/call-center/history.ts`; UI `src/components/call-center/history/`.

- Sub-tabs: **Calls & SMS** | **Activity**.
- Calls & SMS: filter chips All, Calls, Answered, Missed, SMS, Unattached
  (a number that matches no lead or client); search by name or last 4.
  Newest first, 50 per page with "Load more".
- Row: direction icon (in/out/missed/voicemail/SMS), name (lead/client name,
  else "•••-•••-1234"), day ("Sun 11" this week, else "Oct 4"), rep first
  name, duration m:ss, a round **▶** play button when there is a recording
  (inline player, one at a time, speeds 1×/1.5×/2×), chevron → opens the lead
  or client. Tapping an SMS row expands the text.
- Activity: CallCenterEvent + calendar slot changes + audit rows relevant to
  the desk (outcomes, notes, holds, confirms, DNC, intake link sent), newest
  first, with who and when.
- Scope: the actor's organization; a Closer sees calls they placed/answered
  and calls on leads they hold, a Super Admin sees all (mirror `canSeeCall`).

## 4. Messages (lane C)

**Team chat comes first.** Messages opens on the internal team chat (the one
SunOff team chat, drawn natively, docs/CYS_BRIDGE.md §B4 and
docs/TEAM_CHAT_PARITY.md); a switch at the top reads "Team chat | Leads (SMS)",
each with its unread pill. `?view=sms`, `?t=` and `?q=` open the lead text
inbox below, and every inbox link keeps `view=sms`. The Messages tab badge is
lead texts plus team chat: the server render and the 20 s refresh bring both,
the chat's socket keeps the team count live while it is on screen, and
`GET /api/chat/unread` covers the rest (every 45 s while visible); the page
title carries a "(n) " prefix while it is above zero. Below 1024 px the top
bar shows the open conversation's name. Deep links: `#c=<channel>`,
`#m=<message>`, `#thread=<root>`, `#case=<lead id>` (the lead panel's
**Team chat** button). Device notifications: Team chat › 🔔 Notifications
(push-only `public/chat-sw.js`).

The lead text inbox (the rest of this section):

Server: `src/lib/call-center/messages.ts`; UI
`src/components/call-center/messages/`.

- Store: texts for Call Center leads are CallCenterEvent rows of type `SMS`
  (outbound written by the send action; inbound written by
  `processInboundMessage` when the sender's phone hash matches a lead in the
  org; add that write without changing anything else that function does).
  Body is stored; direction in a small JSON prefix is NOT allowed: add an
  additive nullable column `CallCenterEvent.direction` ('in' | 'out') and
  `readAt` (for unread badges) via a migration. Client texts stay in
  Communication.
- List: one thread per lead/client/unknown number, newest first: name, last
  message snippet, time, unread dot. Search.
- Thread view (full screen on phones, right pane on desktop): bubbles, day
  separators, a composer that sends through the existing send path
  (consent + quiet hours + STOP enforced server-side). While A2P is not
  approved, the composer stays usable and a failed send shows the plain
  reason ("Texting is waiting on carrier approval") on that bubble.
- Opening a thread marks its inbound texts read.

## 5. Leads and Booked

- **Leads** (lane A): the existing desk list + lead panel + filters (All,
  Forms, Inbound, Not contacted, Retry, Do not call, Missed) with its search.
  The lead panel's Result, the wrap-up, the Missed "Close as" and the Booked
  visit Outcome are each one grouped dropdown, never a row of buttons
  (docs/DIALER_POWER.md § Result dropdowns).
  The lead panel's Comms trail shows only the newest 3 call recordings (and
  every event after the oldest of them); "Show more (N)" above the list
  reveals 10 more at a time and "Show less" collapses back to 3
  (`src/lib/call-center/trail-window.ts`, `comms-trail.tsx`).
- **Booked** (lane A): the calendar planner as built.

## Phone numbers

Owner ask 2026-10-13: lead numbers showed as dots ("••5080"). Now:

- **Who sees a full number** (`maySeeLeadPhone`, `src/lib/call-center/phone-display.ts`):
  a Super Admin on any lead in the workspace, or the rep who holds the lead
  when it is not on do-not-call. The second half is the rule
  `revealCallCenterContactFor` already used for the dial; nothing new is
  revealed to a rep. Everyone else keeps `•••-•••-1234`.
- **Where it is read**: `leadPhonesFor` / `withLeadPhones`
  (`src/lib/call-center/lead-phones.ts`, server-only) decrypt `phoneSecret`
  (VAULT_KEY) only for the leads the viewer may see and put a `phone` view on
  the row. The desk load (`load-leads.ts`), History (`history.ts`), Messages
  (`messages.ts`, lead threads only; client numbers are unchanged), the
  calendar (`calendar-tab.tsx`) and Missed calls (`listMissed`, the caller's
  own number) all use the same rule. No audit row per render: it is the same
  reach the dial already has.
- **How it reads**: `(702) 555-0123` for US numbers, `+<digits>` otherwise.
  A number on file that will not decrypt reads **Number unavailable**, not dots.
  No number at all reads "—".
- **Tap to copy, never `tel:`**: the lead panel, Today, Messages and the
  calendar panel render it as a copy button (`lead-phone.tsx`). It is plain
  text inside another control (the list row). Every dial still goes through
  Call and the server's outbound decision.
- **Unchanged on purpose**: the team chat / case feed and the SunOff bridge
  carry last 4 only (`cases.phone4`, docs/CYS_BRIDGE.md); SMS bodies and
  transcripts keep their numbers masked; the incoming-call banner is one TwiML
  sent to every ringing rep, so it keeps the name or last 4.
- **Dial pad recents** show the full numbers this browser typed
  (docs/DIAL_PAD.md).

## 6. Interfaces between lanes

Lane A renders sections B and C from server-rendered slots, like Ads today:

```ts
// lane B
export async function HistorySection(props: { user: SessionUser; params: Record<string, string | string[] | undefined>; base: string }): Promise<JSX.Element>
// lane C
export async function MessagesSection(props: { user: SessionUser; params: Record<string, string | string[] | undefined>; base: string }): Promise<JSX.Element>
export async function unreadMessageCount(user: SessionUser): Promise<number>
```

`base` is `/call-center?s=history` / `/call-center?s=messages`; every link a
section builds keeps it. Lane A imports these names; until they land, lane A
stubs them locally in `src/components/call-center/sections-stub.tsx` and the
integrator swaps the import.

## 7. Look

The desk look (`.final-desk.call-center`, cream background, white cards,
navy ink, teal brand, Fraunces display + IBM Plex body). Phone first:
390 × 844 target, 360 must not break, 44 px taps, 16 px inputs, bottom sheets,
no horizontal overflow, safe areas. Desktop ≥1024 must look intentional, not a
stretched phone. Respect prefers-reduced-motion.

## 8. Verification (each lane)

- vitest for new pure helpers and loaders (test DB), the door test
  (`src/lib/call-center/model.test.ts`) updated to the new shell but keeping
  its guarantees (no `fetch(`, no `process.env`, no `router.push`, no carrier
  imports in the screen).
- `npx tsc --noEmit`, `npx eslint` on touched files.
- Playwright on the local e2e DB (`prodigyflo_orient_e2e`,
  `admin@prodigyflo.ai` / `DEMO_STAFF_PASSWORD`, `PRODIGYFLO_FINAL_DESK=true`,
  `CALL_CENTER_CALENDAR=true`) with seeded data for that lane: screenshots at
  390, 360, 1024, 1440; no horizontal overflow; no page errors.
