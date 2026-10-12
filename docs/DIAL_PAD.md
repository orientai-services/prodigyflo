# Dial pad: build contract

Branch `feat/dial-pad` (base: `feat/dialer-mode-alerts`, which turns the Call
Center into "dialer mode"). Owner ask (2026-10-11): "add a dial pad system to
the dialer". Built natively in this repo; nothing shared with any other product.

The existing rules hold (`docs/TELEPHONY_LIVE.md`): compliance runs on the
server for every dial, the browser never sends a phone number for a known
contact, every carrier write is idempotent. A hand-dialed number is the one
case where the browser does send digits, and this contract says exactly how.

## 1. What it is

A keypad in the Call Center (dialer mode) to call any US number by hand, the
way a desk phone does:

- Header button **Dial pad** (icon: 3×3 grid) next to Phone setup. On a phone
  it opens as a bottom sheet (mount in `sheetHost`, like the scheduler); on a
  desk as a popover under the button.
- A number display, formatted as the rep types: `(725) 555-1234`. Typing on
  the keyboard works when the pad is open (digits, Backspace, Enter = Call,
  Escape = close). Paste works (`+1 725-555-1234`, `7255551234`, `1 (725)…`).
- Keys 1–9, `*`, 0, `#`, and ⌫. `*` and `#` are accepted but a number with
  them never dials (they exist for in-call DTMF, which the call bar already
  has).
- **Call** button: enabled for a valid US number (10 digits, or 11 starting
  with 1). It uses the same `checkDial` → `voice.call()` path as the Call
  button on a lead, with target `number:+1XXXXXXXXXX`. When browser calling
  is off, Call is a `tel:` link to the same number instead.
- A **Text** button is out of scope (texts stay on consent).
- Under the keypad, one line in plain words: "Do-not-call and calling hours
  still apply. Known clients and leads are matched by number."
- Last 5 hand-dialed numbers (this browser, localStorage, masked to
  `(725) •••-1234` in the list, full number kept for redial).

## 2. Server contract

- `DialTarget` gains `kind: 'number'`, `id` = E.164 (`+1` + 10 digits).
  `parseTargetKey` accepts `number:+1XXXXXXXXXX` only in that exact shape.
- `resolveDialTarget` for `number`:
  1. Normalise with `toE164`; anything that is not a US E.164 → `NO_NUMBER`
     ("Enter a 10-digit US number.").
  2. Match a **client** in `clientScope(actor)` by phone → return exactly
     what `resolveClient` returns (purpose and basis come from the client's
     stage, as today).
  3. Else match a **CallCenterLead** in the actor's org by phone hash →
     return what `resolveLead` returns with `requireLock = false` (a hand
     dial of a known lead is allowed without the desk lock; the call still
     links to the lead).
  4. Else an unknown number: `who` = the formatted number, `clientId` and
     `leadId` null, `purpose: 'servicing'`, `servicingBasis: 'Hand-dialed by
     <rep name>'`, `zoneHints: { e164 }`. Do-not-call (internal list and
     the existing registry/area-code logic in `decideOutbound`) and calling
     hours still decide; the hours override works the same as for leads.
- The TwiML side (`outbound-voice.ts`) re-resolves the target the same way,
  so the carrier never dials a number the server did not approve.
- Every hand dial writes an audit row `telephony.hand_dial` with `last4`
  and the match kind (`client` | `lead` | `unknown`), never the full number.
- The VoiceCall row carries `clientId`/`leadId` when matched, so the call
  shows on the client file or the lead trail as usual.

## 3. Files

- `src/lib/telephony/targets.ts` (+ tests in `targets.test.ts` or the
  existing telephony test file): parse + resolve for `number`.
- `src/lib/telephony/voice-contract.ts`: the `DialTarget` union.
- `src/components/call-center/dial-pad.tsx` (new, client): the keypad.
- `src/components/call-center/call-center.tsx`: the header button and the
  sheet/popover mount. Keep the door test
  (`src/lib/call-center/model.test.ts`) passing: no `fetch(`, no
  `process.env`, no `router.push`, no carrier imports in the screen.
- `src/components/call-center/call-center.css`: keypad styles in the desk
  look (44 px keys on phones, 40 px on a desk; `.final-desk` reset applies).
- `src/lib/telephony/ui/dial-pad.ts` (new, pure, tested): `formatAsTyped`,
  `normalizeTyped` (digits only, strip leading 1), `isDialable`.

## 4. Verification

- vitest: the new pure helpers, parse/resolve for `number` (client match,
  lead match, unknown → servicing with basis, non-US → NO_NUMBER), the door
  test, and everything under `src/lib/telephony`.
- `npx tsc --noEmit`, `npx eslint` on touched files.
- Playwright against the local e2e DB (`prodigyflo_orient_e2e`,
  `admin@prodigyflo.ai` / `DEMO_STAFF_PASSWORD`, `PRODIGYFLO_FINAL_DESK=true`):
  open `/call-center`, open the pad, type a number, see it formatted, see
  Call enabled, screenshots at 1440 and 390 with no horizontal overflow.
