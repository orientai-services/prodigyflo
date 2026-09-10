# STATUS — SCS Intake + ProdigyFlo

**This is the live status file. Update it in the same commit as the change it describes.**
It is duplicated in both repos (`orientai-services/scs-intake`, `orientai-services/prodigyflo`)
and the two copies should be kept identical — the two apps are one product and one pipeline.

How to maintain it: move items between `OPEN` / `IN PROGRESS` / `CLOSED`, add a dated line to
the Change log, and keep `Last updated` current. Do not delete closed items for at least a
release — the record of what was fixed is the point.

**Last updated:** 2026-09-10
**Deployed:** `scs-intake-42.vercel.app` · `prodigyflo-42.vercel.app`
(Vercel team OrientAI, production branch `main`, push-to-deploy live)
**Databases:** Supabase org SCS (Pro) — `vspmjtdwlcqfclkgksel` us-east-1 (SCS),
`acgmcenrbwabmpxzgwqb` us-west-2 (ProdigyFlo)
**Revert point:** tag `pre-advisory-reframe` in both repos

---

## 0 · Blocking — must resolve before real homeowner traffic

| # | Item | Why it blocks | Owner |
|---|---|---|---|
| B1 | **Repositioning is half done.** The homeowner-facing journey now reads as advocacy and introduction. ProdigyFlo still speaks the old language internally — closers, READY, Strawberry submitting to CYS/attorney — and the marketing site has not been swept. | Staff see "closer" and "Submit" while the public site says we only review and introduce. The two halves describe different businesses. | Dakota |
| B3 | **No `RESEND_API_KEY`** — no confirmation email, no resume link. | The funnel promises "add it later from the link we email you". That link never sends. Anyone who does not finish in one sitting is lost. | Dakota |
| B4 | **No Turnstile keys** — public form, no bot protection. | Spam will pollute the CRM, and ad spend will pay for it. | Dakota |
| B5 | **251 seeded fake clients in the production CRM** (250 demo homeowners + 34 staff users). | Real leads land indistinguishable from fixtures in a closer's queue. | Dakota |
| B6 | **`PRODIGYFLO_CONNECTOR_TOKEN` is still `local-dev-token`** — hardcoded in `prisma/seeds/intake.ts`, readable by anyone with repo access. | Anyone who can read the repo can post leads into the CRM. Rotate the env var and the `IntakeSource.secretHash` row together or delivery breaks. | Dakota |

**B2 is closed** — see below. The counsel-pending guarantee copy was removed rather than
softened, so there is nothing left on that screen awaiting sign-off.

## 1 · Open

### The reframe, continued
- **Document-retrieval modules.** Every mirror gap already carries a `DocumentNeed`; nothing
  consumes it yet. Planned: Gmail deep-link search, generic webmail instructions (Outlook,
  Yahoo, iCloud), a lender/servicer portal registry (TradeBloc, Sunlight, GoodLeap, Mosaic,
  Dividend), and utility-bill guidance. **Utility rule: 6 months before installation and 12
  months after — unless it has been under a year, then everything since.**
- **Provider registry and the introduction step.** Partners are unofficial and unsigned.
  Copy deliberately says "a provider that handles cases like yours", not "the best provider
  for you" — an introduction, not a ranking, which is what we can support today and what
  keeps the claim honest without a compensation disclosure.
- **ProdigyFlo's internal language** (part of B1). Closer → advisor, READY → referral-ready,
  Submit → handoff. Decide before staff train on the old vocabulary.
- **Marketing site sweep.** `src/config/marketing.ts` and `content.ts` were only spot-fixed.

### Product
- **Extraction quality.** `EXTRACTION_PROVIDER=mock` read a purchase agreement as *"A lease"*
  and marked it "from your document"; it misses payment, lender, rate and balance entirely.
  The mirror renders 2 findings and 5 gaps as a result. Switching to `anthropic` is one env
  var plus `ANTHROPIC_API_KEY` (~$0.20–0.30/contract), no code change. **This is the single
  biggest lever on whether the mirror is worth anything.**
- **Cross-document identity verification — unimplemented.** Per the requirements note on
  `main`: first name, last name and home address must be verified against the intake form on
  every uploaded document. Utility bill is the only *name* exception (may be a spouse's); the
  **address must match across all documents**. `signer_name` is now mirrored, which gives the
  anchor to compare against.
- **ProdigyFlo CRM never opened.** `/login` returns 200 but nobody has logged in. The
  SCHEMA_42 packet panel, closer-win brief and READY gating are unverified end to end.
- **The fade-in is slow.** Every screen transition animates slowly enough that automated
  clicks repeatedly landed on invisible elements. A real user on a poor connection feels the
  same delay.

### Infrastructure
- `CALENDLY_WEBHOOK_SIGNING_KEY` unset — booking webhook 501s, bookings do not flow back
  automatically. Visible in Calendly regardless. Low priority.
- `SLACK_WEBHOOK_URL` unset — no staff alert on new leads. Optional.
- **The divergence.** ProdigyFlo here lacks Mailbox and the Planning work boards that exist in
  the Hycamax tree (2 migrations, 16 Prisma models/enums). Reconcile is rehearsed and lands at
  966/966 tests; one conflict in `src/app/api/jobs/run/route.ts` (~4 lines).
- **DNS cutover** — `solarcontractservices.com` and `prodigyflo.ai` still point at the
  DigitalOcean droplet `64.23.190.77`. Deliberately untouched.
- **Cleanup** — 3 dead Vercel projects (`scs-intake`, `gatsby-scs-intake`, `scs-stage1`),
  2 orphaned Supabase projects in the wrong account (`tozjxujvckeciexyvbpw`,
  `hftqdhbkcixuntdscscf`), misleading branch `feat/schema-42-on-p0-mvp` (named as the
  reconcile, contains none of it), ~6 GB of stale local trees.
- **Claude Supabase connector points at the wrong account** — it cannot see the real projects,
  which is how the two orphans got created.

## 2 · In progress

Nothing mid-flight. The mirror and the reframe are both shipped.

## 3 · Closed

| Date | Item |
|---|---|
| 09-10 | **B2 closed.** Guarantee and credit-protection claims removed, not softened. The two standing `APPROVED_EXCEPTIONS` in `check-copy.ts` deleted with them — a stale exception waits quietly until someone reintroduces the phrasing. Copy guard now passes with zero exceptions |
| 09-10 | Journey reframed to advocacy and introduction — offer screen, process steps, marketing step 4, exit copy |
| 09-10 | **Consent corrected** (`contract_review` v2026-09-10.1). Old text authorised sharing with "its partner law firm", which does not exist — authorising a disclosure that never happens and not the one that does. Sharing is now conditional on the homeowner asking for an introduction |
| 09-10 | **The mirror** (`src/lib/mirror.ts`) — restates a homeowner's own documents and does arithmetic on them, never assesses. Enforced by `check:mirror`, verified by breaking it three ways |
| 09-10 | `/findings` renders the mirror after `/review`, with page + quote citations and gaps naming the document that answers them |
| 09-10 | **Per-field confirmation.** Every machine-read value needs a decision — confirmed, edited or cleared — before the file advances. Enforced server-side from our own extraction rows, so omitting a field from the payload cannot smuggle it through |
| 09-10 | Mirror reads endorsed values, not extractor proposals — it was restating values the homeowner had just corrected |
| 09-10 | **The reading screen no longer evicts anyone.** It used to push to `/apply/eligibility` on a timer, silently — and because `/review` is reachable only from this screen, a timeout did not just interrupt the wait, it skipped the confirmation gate entirely and machine-read values were never put to the homeowner at all. A slow queue now produces a choice: keep waiting, or go and answer the questions. When the queue finishes after someone has settled in, they get a button rather than being yanked mid-sentence |
| 09-10 | **Something to read while you wait.** The five guides render as a grid under the progress card, every link opening in a new tab — this page kicks the worker and polls it, so navigating away from it stops the thing being waited for |
| 09-10 | Animation recoloured onto the brand ramp — gold folder, cream sheets, on a navy tile using `--scs-tile-bg`, the same fill the logo mark sits on. The tile is what lets one ramp serve both themes: a navy folder would read on cream and vanish against the dark card, and the tile does not follow the theme. `build-animation.mts` asserts every source colour is found the expected number of times, so a re-export cannot quietly reintroduce blue |
| 09-10 | **Folder-processing animation** on the reading screen, derived from the supplied `.lottie` by `scripts/build-animation.mts`. `lottie-react` was tried first and cost 727KB in one chunk — its entry is a barrel re-exporting every build, so the light component still dragged the canvas renderer in behind it. The light ESM player imported directly is 161KB, and total client chunks fell 569KB |
| 09-10 | **The experience step drafts the story from the tiles.** A "Write a first draft from these" button under the multiselect sends the picked tiles (in their own first-person labels) plus facts already on the lead — installer, lender, agreement type, signing month, both bills — to `claude-sonnet-5`, and the draft lands in the "in your own words" box for them to edit. Each press is a fresh draft. Nothing is recorded until they press Next; the draft is a suggestion in a text box. It says what was said and what happened and never what it means: a banned-word filter (`src/lib/plain-language.ts`, shared with the mirror guard) runs on the way out, a second pass names the words and asks for what happened instead, and two strikes returns a blank box. The last sentence states the situation driving this and never proposes a remedy — the first draft said "I need the payment lowered" from a tile that said "I can't afford the payments", and that was tightened before shipping. Verified locally: two presses, two different drafts, both plain, and the button reads "Replace what I wrote with a new draft" once the box has been edited |
| 09-10 | **The upload door stays open on every form question.** Choosing the form at the fork used to close it until the documents step, several screens on. Every step now carries a quiet "Have your paperwork handy? Upload it instead" link (absent on the documents step itself and wherever uploads are not configured), and the upload page's secondary button reads "Back to my questions" and returns them to their first unanswered step rather than "Start the intake form". Verified: money → upload → back → money, step 2 of 7 |
| 09-10 | **Payments since signing, and the balance floor.** The mirror now says *"If a payment has been made every month since March 2024, that is 30 payments so far — $5,670 at $189 a month"* and, only when the document did not state a balance, *"Against the $48,900 financed, that would leave about $43,230 if every dollar went to the balance. With interest at 3.99%, the actual balance is higher — read this as the lowest it could be."* Arithmetic on their own numbers with the assumption in the sentence; never shown beside a documented balance; never negative. Guard covers all four cases and was broken three ways to prove it |
| 09-10 | **Seven mirror statements were unreachable, and now are not.** `total_financed`, `dealer_fee`, `signer_name`, `escalator_rate`, `balloon_amount`, `production_guarantee` and `buyout_terms` were extracted but never shown on `/review`, so they could never be confirmed, so the findings screen — built from confirmed values only, correctly — could never say "the total amount financed is $48,900" or the dealer-fee share. Found because the new balance line depends on one of them. All seven are reviewable now, and `check:mirror` fails if the mirror ever cites a field the review screen cannot show |
| 09-10 | **D7 closed — a batch is read as one document.** A contract photographed page by page was N files, and each file was asked to answer questions only the whole agreement can answer: page 1 carried the title and returned `ppa`, page 2 carried the Truth-in-Lending box and returned `loan`, both high confidence, and upload order decided. The worker now claims whole groups — one lead, one doc type — and reads them in a single call, splitting only past 8 files. Verified end to end: the same three pages that produced `ppa` now produce **A loan**, cited to the file and page it was read from |
| 09-10 | Grouping is **cheaper as well as righter** — three files went from three calls at ~8k tokens each to one call at 8,145 tokens, $0.096 → $0.032, and returned 15 fields where the split returned 9/5/6 with two contradictions. Citations now name the file (`contract-p2.pdf · page 1`), which "page 1" three times never could |
| 09-10 | **D8 closed — the mock rows are gone.** 82 mock extractions on live documents re-queued and re-read by `claude-sonnet-5` across 10 leads, $2.17. Verified on production: a lead that displayed "A lease" from a regex fixture no longer does. 1 mock row and 22 never-run rows remain, all on documents that were deleted — the worker skips those by design |
| 09-10 | **T2 closed — a real contract went through.** A 22-page Titan Solar purchase agreement, 640KB, text-layer path: 11 fields at high confidence including installer, signer, address, 2.99% APR, `loan`, $36,819.55 financed and GoodLeap as servicer. **$0.145** — a real contract costs roughly five times the synthetic fixture, which is the number to plan against, not $0.03 |
| 09-10 | **T4 closed — the malformed-JSON retry fired for real.** That same contract failed its first attempt on truncated JSON and succeeded on the second. The backoff path that made the move off strict structured output survivable has now been observed working rather than assumed |
| 09-10 | **Production had never run real extraction.** `EXTRACTION_PROVIDER` was `mock` on Vercel with no `ANTHROPIC_API_KEY` or `EXTRACTION_MODEL` set at all — the plan's step 1 was applied locally and never to production, and nothing checked afterwards. Found by tracing an 80-document upload: all 80 saved, 39 read by a regex fixture that only matches a PDF text layer, 41 never touched. Now `anthropic` / `claude-sonnet-5` |
| 09-10 | **Extraction drains concurrently and the waiting screen keeps kicking it.** A drain was serial and took 3 for a browser call; the screen kicked it once on mount and gave up at 90s, so 3 of 80 were read before the homeowner was dropped into the questions. Now 12 per browser drain / 25 per cron, 4 at a time, re-kicked while documents remain, with a ceiling that scales with queue size. One kick drains 10 documents in 52s where it used to take 3 |
| 09-10 | **Extraction rows are claimed with `for update … skip locked`.** Select-then-update was safe only while one drain ran at a time; re-kicking makes overlap routine. Proven both ways — two simultaneous drains split 10 rows 4/6 with no overlap, where the old pattern claimed 12 of 10 and would have paid twice for six documents |
| 09-10 | **Multi-file upload.** Every document row takes a whole batch at once. Fixed a stale-closure bug found on the way: `upload` closed over `docs`, so two files in flight both appended to the same captured array and the second silently overwrote the first — nothing errored, a file just never appeared. Verified in the browser with a 3-file batch, all three persisted across a reload |
| 09-10 | "Learn how to find or get your [document]" now renders under all eight upload rows — the primary agreement card was missing one, and acronyms were being lower-cased to "ucc-1" |
| 09-10 | Document uploads working end to end — presigned PUT → private Supabase bucket → DB row; anonymous fetch refused (400) |
| 09-10 | Calendly booking step fixed — was a dead end, `NEXT_PUBLIC_CALENDLY_EVENT_URL` unset |
| 09-10 | Full funnel proven end to end, unattended — upload → extraction → 5 steps → consent → `qualified` → delivery enqueued → cron dispatch → client in ProdigyFlo |
| 09-10 | Supabase private CA pinned; IPv6-only DB host replaced with the IPv4 pooler; `postinstall: prisma generate` added; 12 type errors fixed — each of these independently blocked deployment |
| 09-10 | Repos transferred to `orientai-services`; Vercel git-linked; `main` merged and made production |
| 09-10 | Supabase GitHub integration on ProdigyFlo disconnected — was wired to `dakotahanshew/scs-stage1` |
| 09-10 | Cron verified firing every 5 min on all three scheduled routes, 200 |

## Corrections to earlier entries

- **Extraction is not slow for users.** An earlier note claimed 120–270s. That was an artefact
  of driving the API directly and waiting on the 5-minute cron. `/reading` kicks the worker
  itself (`POST /api/extractions/run`) and then polls, so a homeowner in a browser waits
  seconds.
- **`FILE_STORAGE_DRIVER=local` does not silently lose files on Vercel.** `getFileStorage()`
  throws under `VERCEL`, so it fails loudly.

## Change log

- **2026-09-10** — Mirror shipped, journey reframed to advocacy/introduction, consent
  corrected, per-field confirmation of machine-read values enforced. B2 closed.
- **2026-09-10** — File created after the Vercel + Supabase migration and the first successful
  end-to-end funnel run.
