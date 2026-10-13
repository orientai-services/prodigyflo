# Native feel: build contract

Owner ask (2026-10-13): "make the app a mobile application… go heavy on this
optimization", on iPhone first and on iPad. This contract covers the
Call Center's in-app behaviour; the installed-app layer (manifest, service
worker, splash screens, root safe area, install prompt) is a separate
branch (`feat/installed-app`).

Nothing here changes a server contract or a business rule: every dial, text
and result still goes through the same actions and checks.

## Widths

| Width | Layout |
|---|---|
| < 768 | Phone: bottom tab bar, the open lead and an open conversation are full-screen pushed views, sheets are bottom sheets. |
| 768–1023 | Tablet (iPad portrait, Split View, landscape phones): bottom tab bar, Leads/Today list and lead side by side, Messages list and conversation side by side, More is a card above its tab, the visit panel a centred form sheet. |
| ≥ 1024 | Desk: unchanged for a mouse. With `pointer: coarse` (iPad landscape, touch laptops) every control is at least 44 px and the open lead stays in view while the list scrolls. |

Layout never reads the user agent.

## Behaviour

- **Pushed lead (phone).** Opening a lead adds a `?lead=` history entry
  (`window.history.pushState`, which the Next router follows). ‹ back,
  Android back and a swipe from the left 28 px all close it; the swipe
  follows the finger and goes back past 35 % of the width or on a flick
  (`src/lib/call-center/native-gestures.ts`). The same swipe presses ‹ in an
  open team-chat conversation, a team-chat thread and a lead SMS thread.
- **Tabs.** A tab tap shows the section's skeleton at once (no blank wait),
  each section keeps its own scroll position, tapping the open tab scrolls it
  to the top. Links from tiles and More open at the top as before.
- **Pull to refresh** on Today, Leads and History (iOS has none in a
  home-screen app): the same `router.refresh()` as the 20 s tick, with a
  spinner until the new render lands.
- **Bottom sheets** (`native/use-sheet.ts`): drag the handle, header or any
  content scrolled to its top down to close; the page behind cannot scroll;
  Tab stays inside; focus returns to the opener; a focused field scrolls
  above the keyboard. Only while CSS lays the element out as a full-width
  bottom sheet, so desk popovers and tablet cards are untouched.
- **Keyboard** (`useKeyboardInset`): `--cc-kb` (px hidden by the on-screen
  keyboard, from `visualViewport`), `--cc-vvh`, `--cc-vvtop` and
  `html.cc-kb-open`. Sheets sit on `bottom: var(--cc-kb)`, full-screen panes
  shrink to the visible area, the tab bar and the call bar's tab offset step
  aside. A pinch zoom never counts as a keyboard.
- **Haptics** (`native/haptics.ts`): call connected, call ended, result saved
  (or refused), dial-pad keys, pull to refresh. `navigator.vibrate` on
  Android; on iOS 18+ a hidden switch checkbox's system tick; nothing
  elsewhere or with reduced motion. Never throws.
- **Touch polish:** pressed states on rows and buttons (touch screens only),
  no tap highlight, `touch-action: manipulation`, inputs at 16 px or more on
  touch screens (no zoom on focus), frosted top bars, toasts above the tab
  bar, fitting `enterkeyhint` / `autocapitalize` / `autocomplete` on fields.
- **Safe areas** go through `--cc-sat` / `--cc-sab`
  (`env(safe-area-inset-*)`); `--cc-test-sat` / `--cc-test-sab` override
  them for emulators, which report zero insets.
- **Reduced motion:** every slide, spring and spinner is off.

Not done, on purpose: swipe actions on lead rows (a swipe-to-call would skip
the lead's own Call button and its checks for no real gain).

## Verification

- vitest: `native-gestures.test.ts` plus the Call Center suites and the door
  test (`model.test.ts`).
- `tsc --noEmit`, eslint on touched files, `next build --webpack`.
- Playwright on WebKit (iPhone 14, iPhone 15 Pro Max, iPhone SE, iPad Pro 11
  and iPad gen 7 in both orientations, Split View 507 / 678) and Chromium
  (Pixel 7, 1440 desk), with the safe-area test hook: every section and
  sheet, zero horizontal overflow, zero page errors; touch-gesture checks
  (sheet drag, edge swipe, history back, pull to refresh, tab scroll memory).
