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

## Installed app (2026-10-13)

Owner ask: "when I save it on my phone it's not very mobile friendly and I
can still see all the browser buttons. Make the app a mobile application."
The owner uses an iPhone; iPads must work too.

### What makes it open as an app

- **Every page** (sign-in included) emits, from `src/lib/pwa/app-chrome.ts`:
  - `apple-mobile-web-app-capable=yes`, written by hand through metadata
    `other`. Next 16 only emits `mobile-web-app-capable` for
    `appleWebApp.capable`, and without the Apple name an older iOS (or a
    page saved before the manifest loaded) opens the icon inside Safari.
  - `apple-mobile-web-app-status-bar-style=black-translucent` with
    `viewport-fit=cover` app-wide (root `viewport` export). The page runs
    edge to edge; `env(safe-area-inset-*)` reports the notch, the home
    indicator and, in landscape, the side insets.
  - `theme-color` for light and dark (`#12202c` / `#0b151d`, the desk navy).
  - 80 `apple-touch-startup-image` links: 20 current iPhone and iPad sizes,
    portrait and landscape, light and dark. The PNGs are rendered from each
    brand's icon at build time by `src/app/splash/[brand]/[file]/route.ts`
    (nothing committed, about 13 KB each).
  - `apple-touch-icon` 180 (iPhone), 167 (iPad Pro), 152 (iPad).
  - `format-detection: telephone=no` (real `tel:` links still dial).
- **Status band.** black-translucent always draws a white clock, so
  `.pf-status-band` (root layout + globals.css) paints the top inset navy
  over every page. Its height is 0 in a browser tab and on Android.
- **Manifest** (`src/lib/pwa/manifest.ts`, served per account at
  `/manifest/<slug>`): `id: '/'` (keeps already-installed Android apps the
  same app), `start_url: '/app'`, `scope: '/'`, `display: standalone`,
  `orientation: any`, paper background, navy theme, `launch_handler`
  navigate-existing, maskable icon (mark inside the 80% safe zone, checked),
  shortcuts Today / Dialer (`?pad=1` opens the keypad) / Messages / Leads
  with icons in `public/pwa/` (regenerate with `node scripts/pwa-assets.mjs`).
- **`/app` launcher** (`src/app/app/route.ts`): a bare 307 to the Call
  Center for desk roles (`installedAppLanding` in `src/lib/staff-routes.ts`),
  no page in between, so no flash. Signed out, the proxy sends it to
  `/login?next=/app` and sign-in returns there. The landing can change later
  without anyone reinstalling.

### Staying inside the app

- Auth.js redirects are same-host paths (`redirect` callback +
  `sameSitePath` in `src/lib/auth.ts`). The default built absolute URLs on
  `AUTH_URL`'s host; any mismatch with the installed host (apex vs www)
  would push the app out of its scope and bring Safari's toolbars back.
- In standalone mode, same-origin page links marked `target="_blank"` (for
  example "Open the full file ↗") navigate in place
  (`src/components/pwa/in-app-links.ts`). Files, `/api/*`, downloads and
  other origins (Meet, chat files, maps) still open in the system browser
  sheet, which has a Done button. `tel:` and `sms:` go to the phone.
- Email links (magic link, password reset) always open in Safari, which has
  its own sign-in apart from the installed app. Inside the app the sign-in
  page says so and points to the password form; the reset confirmation says
  to come back and sign in with the new password.

### Service worker (`/sw.js`, scope `/`)

Source in `src/lib/pwa/service-worker.ts`, served by `src/app/sw.js/route.ts`
stamped with the deploy's commit, so every deploy is a new worker.

- Pages: network first (with navigation preload); `/offline.html` only
  when the network is unreachable. Authenticated HTML is never cached.
- `/_next/static`, `/brand`, `/pwa`, `/splash`: cache first, capped at 600
  entries.
- Everything else (API, server actions, RSC, recordings, non-GET, other
  origins): untouched.
- New deploy: the new worker takes over and the open app shows "A new
  version of ProdigyFlo is ready. Reload". The app re-checks when it comes
  back to the foreground (at most every 30 min).
- Team chat push keeps its own worker on `/chat-sw/`; the root worker has no
  push handler. `/sw.js` and `/offline.html` are public in `src/proxy.ts`.
- Kill switch if it ever misbehaves: make `serviceWorkerSource` return a
  worker whose `activate` deletes the `pf-*` caches and unregisters itself.
  Production builds only (`next dev` never registers it).

### Install entry

`src/components/pwa/` (install-store + install-app): Call Center › More,
the desk rail, the app-shell user menu and the sign-in page show "Install
app" unless the app is already running standalone. Android and desktop
Chrome get the browser's own install dialog (`beforeinstallprompt`, parked
by the head script before hydration). iPhone and iPad get an illustrated
sheet (Safari: Share › Add to Home Screen › keep "Open as Web App" on;
Chrome on iOS: Share in the address bar). The platform guess only picks the
how-to, never layout; iPadOS's Mac user agent is recognised by touch points.

### Native feel

- `overscroll-behavior: none` on the page in standalone mode (no rubber
  band); inner scrollers keep theirs.
- `touch-action: manipulation` on controls, no tap highlight, no text
  selection or link previews on buttons, the tab bar and the rail.
- Fields are at least 16 px on every touch device (phones and iPads), so
  iOS never zooms on focus. Pinch zoom stays allowed.
- Keyboard: `InstalledAppRuntime` publishes `--vvh`, `--vv-top`, `--kb` and
  `html.kb-open`. Full-screen thread, conversation and lead panels size to
  the visible area, so the composer stays above the keyboard; the tab bar
  hides while typing; bottom sheets sit on the keyboard.
- iPad landscape (≥1024, the "desk" layout): the Call Center header, the
  desk rail and header, and the app-shell header grow by the top inset.
- Toasts sit below the notch.

### Reinstalling (everyone with the old icon)

The old icon was saved without these tags, and iOS keeps what it saw at
install time. Delete it and add it again.

- **iPhone / iPad, Safari:** press and hold the ProdigyFlo icon › Remove
  App › Delete from Home Screen. Open www.prodigyflo.ai in Safari, tap Share
  (on iOS 26 inside the ⋯ menu) › Add to Home Screen, keep **Open as Web
  App** on, Add. Open it from the icon and sign in once (the app keeps its
  own sign-in, apart from Safari's).
- **iPhone, Chrome:** Share in the address bar › Add to Home Screen.
- **Android, Chrome / Samsung Internet:** remove the old icon, open the
  site, More › Install app (or the browser menu › Install app).

### Verification (2026-10-13)

Local `next start` on the e2e database with the final desk on. Playwright
Chromium (Pixel 7) and WebKit (iPhone 14, iPhone 15 portrait and landscape,
iPad Pro 11 and iPad (gen 7) portrait and landscape):

- The served HTML of `/login` and `/call-center` carries every tag above (80
  startup images, 3 touch icons, both theme colours).
- Manifest valid; every icon and shortcut icon is 200 `image/png`.
- `/app` 307s to `/call-center` signed in, to `/login?next=%2Fapp` signed out.
- The service worker registers at `/` and controls the page in both engines.
  The offline page shows when offline in Chromium; Playwright's WebKit on
  Windows cannot navigate offline at all, so that check runs in Chromium only.
- No horizontal overflow on Today, Messages and Leads on every device above,
  or on `/call-center` and `/board` at every width from 320 to 1366 (Split
  View and Stage Manager sizes). No console errors.
- Safe-area screenshots with Chromium's inset override: navy band over the
  notch, headers below it, side insets respected in landscape.
