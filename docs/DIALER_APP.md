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
Compliance rules are unchanged: the server decides every dial and every text;
full phone numbers never reach the list views (last 4 only).

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
- **Booked** (lane A): the calendar planner as built.

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
