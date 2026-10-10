# Dialer power-up: build contract

Branch `feat/dialer-power`. This brings the habits that make a fast dialer to
the Call Center desk. Everything is built natively in this repo. No code,
numbers, credentials or data are shared with any other product.

The existing rules still hold: `docs/TELEPHONY_LIVE.md` (compliance runs on the
server for every dial, a lead must be locked by the rep, the full number never
reaches the list, every carrier write is idempotent).

Three lanes are built in parallel, and their files don't overlap.

## Shared contract (already on the branch)

`useVoice()` now also exposes:

- `lastCall: EndedCall | null`. It is set once per ended call in this tab. Its
  fields are `seq`, `target` ('lead:<id>' | 'client:<id>' | 'missed:<id>' | ''),
  `direction`, `who`, `answered`, `talkSeconds`, `endedAt` and `error`. React to
  `seq` changes.
- `activeTarget: string | null`. The target of the call in progress.

Constants every lane uses:

- CONNECTED_SECONDS = 20. An answered call shorter than this counts as
  unanswered for the cadence and for auto-contact.
- Desk scheduling window: 9:00–20:00 in the **lead's** local time. The server's
  compliance window stays the authority for real dials.

## Lane A: desk (`src/lib/call-center/*`, `src/components/call-center/*`, `src/app/(app)/call-center/*`, `src/components/voice/incoming-call.tsx`)

1. **Today view** is the desk's default tab.
   - KPIs: New not contacted, Follow-ups due, Booked today, Calls today.
   - A "Call first" card shows the top 3 leads, each with a one-line *why*.
   - Below that are collapsible queues: Callbacks requested / missed, Due now,
     New, Going cold (contacted, nothing for 3+ days, no follow-up).
   - Ranking is a pure function in `priority.ts`, with tests:
     - tier 0: callback due within the next hour, or an inbound missed call today
     - tier 1: new lead, not contacted, oldest first. Hot after 5 minutes.
     - tier 2: follow-up overdue, most overdue first
     - tier 3: going cold
2. **No-answer cadence** (`cadence.ts`) replaces the fixed 1/3/7-day retry.
   - Steps after an unanswered attempt: +5 min, tomorrow 10:00, day after
     tomorrow 17:00, +2 days, +3 days, +3 days.
   - Times are in the lead's zone and clamped into 9–20: too early moves to
     10:00 the same day, too late to 10:00 the next day.
   - After step 6 the lead is exhausted ("No further tries", and the desk
     suggests closing it).
   - The carrier result advances the cadence automatically in
     `recordCarrierCallFor`: no-answer, busy, failed, or answered for less
     than 20 s. Advances happen at most once per VoiceCall.
   - An answered call of 20 s or more marks the lead contacted and clears a
     cadence-only follow-up.
3. **Callback scheduling.** The Callback outcome opens a small scheduler.
   - It has quick chips: In 1 hour, Tomorrow 10:00, Tomorrow 17:00, In 3 days.
   - It has a day + 30-minute slot picker in the lead's zone, with the rep's
     own time shown when it differs.
   - The chosen time is stored in `nextAttemptAt`, and the Due queue orders by it.
4. **Power mode** (toggle in the header, remembered per browser).
   - When a call ends, the wrap-up panel asks for an outcome. With the toggle
     on it is required before the next dial.
   - It then counts down 5 s to the next lead in the Today ranking and runs the
     same `checkDial` flow as the Call button.
   - The next lead is locked first; leads another rep holds, DNC leads and
     blocked leads are skipped.
   - Pause/Skip are always visible. Power mode never dials through a
     compliance block or an hours prompt; it stops and shows why.
5. **Keyboard shortcuts** apply on the desk, never while typing:
   - J/K next/previous, C call, T take
   - 1–9 outcomes in OUTCOMES order, N focus note, / search
   - P toggle power mode, Space pause the countdown
   - ? shows the list
6. **Live-ish refresh.** `router.refresh()` runs every 20 s while the tab is
   visible, no call is active and no input is focused.
7. **Fix:** `?lead=` and the incoming-call link must accept Meta lead ids
   (`meta:<org>:<leadgen>`). Validate with `parseTargetKey`-style rules, not
   `^[A-Za-z0-9_-]+$`.

## Lane B: voice quality (`src/components/voice/*` except incoming-call, `src/lib/telephony/ui/*`, new `src/lib/telephony/quality.ts`)

1. **Edge selection** from the browser's time zone:
   - Americas west: umatilla, ashburn
   - East: ashburn
   - South America: sao-paulo
   - Europe: dublin; Asia: singapore/tokyo; Oceania: sydney
   - Otherwise: roaming
   - The best edge from the last full test overrides the guess. Pass `edge`
     as an ordered list to `Device`.
2. **Low-data mode** caps `maxAverageBitrate` at 16000 instead of 32000.
3. **Test connection** (Phone settings):
   - It uses `Device.runPreflight` with a fresh token. The server must answer
     a preflight: add `preflight` support to the token action if needed (Lane B
     may touch `getVoiceToken` only).
   - Quick test: one edge. Full test: mic level for 5 s, then up to 3 edges.
   - `recommend()` in `quality.ts` is pure, with tests. Its thresholds:
     - best edge = lowest RTT with loss ≤ 2 % and MOS ≥ 3.8
     - low-data when loss > 3 %, jitter > 30 ms, or bad bandwidth
     - relay when TURN was needed
     - mic silent below −50 dBFS average, or clipping on more than 5 % of frames
     - VPN suspected when RTT > 300 ms everywhere
     - verdict: MOS ≥ 4.1 Excellent, ≥ 3.8 Good, ≥ 3.1 Fair, else Poor
   - An "Apply recommended" button follows the verdict.
4. **Live quality light** in the call bar from SDK `warning` and
   `warning-cleared` events. Red for packet loss, low MOS, constant audio
   level or ICE lost; amber for high RTT or jitter. One plain-English tip, and
   MOS when known.
5. **Audio failover.** If the input track mutes for 1.2 s or ends mid-call,
   switch to the system default mic and say so. Explicit picks still win when
   they come back.
6. A ringtone mute toggle, and the talk timer also in the tab title during a call.

## Lane C: telephony server (`src/lib/telephony/*` except `ui/` and `quality.ts`, `src/app/api/telephony/*`, `src/components/telephony/*`, `prisma/*`, `src/lib/jobs*`, the nav badge)

1. **Missed-call dispositions.** `markMissedCallHandled(id, { disposition, note })`.
   - Dispositions: called_back | no_answer | spam | wrong_number | handled.
   - Handling one clears every earlier pending missed call from the same
     `remoteHash` in the org.
   - The Missed UI gets disposition buttons.
   - An outbound call to the same remoteHash answered for 20 s or more clears
     them automatically (note 'called back'). Do this in the finalize path.
2. **Press 1 for a callback.** After the ring stage fails, before voicemail:
   - `<Gather numDigits=1 timeout=5>`: "To have us call you back, press 1. Or
     stay on the line to leave a message."
   - On 1 the call gets `callbackRequested=true` and `needsAction=true`, the
     caller hears a confirmation, and the call hangs up. Otherwise it goes to
     voicemail.
   - Callback requests sort first in Missed.
3. **Voicemail transcription** via Twilio `transcribe` with a signed
   `transcribeCallback`. The text goes in `VoiceCall.transcript` and shows
   under the voicemail in Missed and in the lead trail. Settings toggle
   `settings.telephony.transcribeVoicemail` defaults to on.
4. **Speed-to-lead** in the 5-minute sweep:
   - A lead counts as untouched when it is FORM, not contacted, has no CALL or
     OUTCOME event, and was created in the last 24 h.
   - At 5 min or more it notifies the reps who are present and the users with
     telephony:manage. At 15 min or more it notifies super admins once.
   - The clock only runs 9:00–20:00 America/Los_Angeles; an overnight lead's
     clock starts at 9:00.
   - Each alert fires once: `CallCenterLead.speedAlertedAt`, `speedEscalatedAt`.
5. **Nav badge.** The pending missed-call count goes on the Call Center nav
   item. It is a cheap count, cached per request.
6. **Migration** `20261009200000_dialer_power`:
   - VoiceCall: callbackRequested Boolean default false, transcript Text?,
     handledDisposition String?
   - CallCenterLead: speedAlertedAt DateTime?, speedEscalatedAt DateTime?
