# Team chat parity with SunOff Chat

Owner ask (2026-10-12): Messages opens on the internal team chat, not SMS, and
the ProdigyFlo team chat matches what SunOff Chat does today, feature for
feature. The chat stays the one approved bridge (docs/CYS_BRIDGE.md §B4, D4):
native screen over the `chat.sunoff.app` API, bearer session, no iframe.

Reference implementation: `sunoff-chat/public/index.html` (master, incl.
41e83e2 category buttons, a6284c8 category order, 8d14638 read ticks) and the
dialer host in `sunoff-leads/public/index.html` (Mensajes).

Every row is a check. "PF" = ProdigyFlo client under
`src/components/call-center/messages/chat/`; "W" = chat Worker branch
`feat/pf-host`.

## A. Shell
- A1 Messages opens on Team chat. `?view=sms`, `?t=`, `?q=` open the SMS inbox; inbox links keep `view=sms`. Switch order: Team chat | Leads (SMS), both with unread pills.
- A2 Messages tab badge updates live from the socket `unread` event (and the 20 s refresh), plus a `(n) ` document title prefix while unread > 0.
- A3 Phone top bar shows the open conversation's name while in Messages.
- A4 Lead panel: "Team chat" button opens that lead's case chat (`#c=<case channel>`), with its unread count.
- A5 Deep links `#c=`, `#m=` (scroll + highlight), `#thread=`; push taps land on them.
- A6 Desktop opens the most recent conversation automatically; phone shows the list first.

## B. Conversation list
- B1 Category buttons with counts and unseen badges, in this order: Direct messages, Clients, Channels (groups count as Channels). "‹" back header; last category remembered (`localStorage chat_cat`); a search shows every match.
- B2 Rows: avatar/icon + presence dot, name, preview with "You:"/"Name:" prefix and voice/photo/file labels, case rows show rep · stage, time, unread pill or red `@n`, 🔕 when muted, ✓ / ✓✓ / green ✓✓ on my last message.
- B3 Live dot (Live / Every 5 s / Offline), offline banner with retry, skeletons.
- B4 Footer: me chip, Salas with "N inside", staff buttons Flagged / Announce / Sync now, Settings.

## C. Messages
- C1 Read ticks on every one of my messages (✓ sent, grey ✓✓ seen by some, green ✓✓ seen by all) and "Sent / Seen / Seen by A, B and n more" under my last one (off over 200 members).
- C2 Grouping (same author within 5 min), day separators, "New" divider, "↓ New messages" jump pill, intro card per channel type.
- C3 Emoji-only messages show big. Links auto-linked.
- C4 Reactions: quick set 👍 ✅ 🔥 🙏 😂 ❤️ + full picker (62); chip tooltip lists who reacted.
- C5 Message menu: reply in thread, react, copy text, edit (author 24 h or staff), delete (author unless flagged, or staff; confirm), pin (staff or creator; roots only). Long-press on touch, right-click on desktop.
- C6 Threads: reply count + "last reply X ago" on the root; drawer on desktop, full screen on phones.

## D. Composer
- D1 Enter sends, Shift+Enter newline (phones: send button), auto-grow, counter after 3,500 of 4,000, draft kept per channel.
- D2 Mentions autocomplete (members, then directory); `@todos/@all/@canal/@channel` offered to staff only.
- D3 Attachments: images (jpeg/png/gif/webp/heic) and PDF, up to 10 per message, 8 MB; images recompressed client-side to ≤1.5 MB / 2560 px; paste, drag-and-drop, 📎. Lightbox for images.
- D4 Voice: touch = hold to record, slide left to cancel; mouse = tap, ■ stop, preview; 5 min cap, timer + level meter. Player: waveform seek, 1× / 1.5× / 2× (remembered), transcript collapsible.
- D5 Case chats: Team (internal) / Client (SMS) toggle; client SMS refusals shown on the bubble.

## E. Channels and people
- E1 New DM / group (2–50, optional name).
- E2 Channel settings sheet: rename, add/remove members (staff or creator), leave, archive, notify all / mentions / none, mute; member list with presence.
- E3 Search: global and inside one channel (🔍 in the header); results jump to message or thread.
- E4 Pins sheet with 📌 count in the header.
- E5 Salas: list rooms with live head count, join (opens Meet), copy link, create (≤20), rename, archive.
- E6 Staff: Flagged inbox, Announce (post to #anuncios), Sync now.

## F. Preferences and notifications
- F1 Settings: language (loaded from `me.lang`, not hard-coded), default notify level, quiet hours (from/to + timezone).
- F2 Device push on ProdigyFlo: a push-only service worker at `/chat-sw.js`, subscribe with the chat's VAPID key via `POST <chat>/api/push/subscribe {subscription, host:'prodigyflo'}`; test button. Tap opens `https://www.prodigyflo.ai/call-center?s=messages#c=<ch>` (or focuses an open tab and routes in place).
- F3 W: push rules unchanged (member, notify level, mute, focus 20 s, quiet hours, 30 s coalesce); PF subscriptions get PF tap URLs.
- F4 W + PF: fallback notice for PF-only users (unread > 10 min, never reached a device): W calls signed `POST {PF}/api/bridge/chat/notify {uid, pf_user_id, title, body, url}`; PF emails the user (one summary per 3 h, no message text beyond the 140-char preview).

## G. Keyboard and a11y
- G1 Ctrl+K focuses search, Escape closes sheet/thread/menu, arrows move the mention list, live region announces new messages, 44 px targets.

## H. Verification
- vitest (format + new pure helpers), `tsc --noEmit`, eslint, `next build`.
- Playwright screenshots at 390 / 360 / 1024 / 1440 against the e2e DB with a stubbed chat server: no horizontal overflow, no page errors.
- W: `npm test` + `tests/pfhost.test.mts` additions.
