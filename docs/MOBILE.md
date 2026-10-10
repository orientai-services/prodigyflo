# Mobile pass: build contract

Branch `feat/mobile`. Owner asks (2026-10-10):

1. The dialer shows only inside the Call Center tab.
2. The whole app works well on a phone.

## 1. Dialer only in Call Center

- The call bar (`VoiceDock`) renders on `/call-center` only.
- Elsewhere it appears only while a call is connecting, ringing or in
  progress, so a rep who navigates away can still hang up, mute or use the
  keypad. When that call ends, the bar goes away again.
- The incoming-call banner (`IncomingCall`) stays app-wide. A ringing caller
  must never be missed because the rep is on another page.
- The `VoiceProvider` stays in the app layout. Registration, presence and
  ringing do not change.
- Click-to-call buttons on other pages (client header, missed calls) keep
  working. They place the call, and the bar appears for that call.

## 2. Mobile standards (every page)

- **Target widths:** 390×844 is the design target. 360×780 must not break.
  768 counts as tablet. Desktop (≥1024) must look exactly as it does today.
  Use additive, mobile-first responsive rules, and never restyle desktop.
- **No horizontal scroll** on the page body at 360 or 390:
  `document.documentElement.scrollWidth <= window.innerWidth`.
  - Wide data tables either become stacked cards below `md`, or sit inside
    their own `overflow-x:auto` container with the first column sticky.
  - Pick whichever reads better for that table.
- **Tap targets:** at least 44×44 px for buttons, links in lists, chips and
  tabs, with at least 8 px between neighbouring targets.
- **Inputs, selects and textareas:** font-size at least 16 px on mobile, so
  iOS doesn't zoom.
- **Bottom-sheet patterns:**
  - Use `100dvh`, not `100vh`.
  - Respect `env(safe-area-inset-*)`.
  - Sticky primary actions sit at the bottom within thumb reach.
  - Nothing important hides under the call bar. When the bar shows, the page
    gets bottom padding equal to its height.
- **Tab rows and filter chips:** scroll horizontally in one row
  (`overflow-x:auto`, hidden scrollbar, snap), never wrap into 3 lines.
- **Navigation:**
  - The app shell already has a mobile sheet.
  - The `final-desk` shell (dark rail, used by Board, Clients, Queue,
    Documents, Submissions, Call Center, …) collapses below `lg` into a
    compact top bar with a menu button that opens the same links in a sheet.
    It must never be a 220 px column eating the phone.
- **Typography:** big desktop display headings (e.g. "Call Center") scale
  down on phones. Keep the brand fonts.
- **Accessibility:** focus stays visible and every control keeps its label.
  Respect `prefers-reduced-motion` for any new motion.

## Verification

- A local server runs against the seeded e2e database
  `prodigyflo_orient_e2e` (login `admin@prodigyflo.ai`, password in env
  `DEMO_STAFF_PASSWORD`).
- Take Playwright screenshots of every owned page at 390×844 and 360×780,
  and at 1440×900 to prove desktop is unchanged.
- Assert there is no horizontal overflow.
- `tsc`, `eslint` and the affected vitest files must pass.
