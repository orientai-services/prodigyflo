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
- **Vision reads are thin on agreements.** T3 is closed (below): the reader works on
  photographed paperwork, and the one Truth-in-Lending chunk came back with 13 fields at
  high confidence. But the two 8-part *agreement* chunks returned 7 and 4 fields and no
  `agreement_type`, `total_financed` or `monthly_solar_payment` — the fields the mirror is
  built on. Whether that is the scans (two pages of a 20-page contract per file, in whatever
  order they were photographed), the chunk split (a contract cut at 8 files answers from half
  a document — the limit logged in §3), or the prompt, is not yet known. The next real
  photographed contract will say. Watch `fields_found` on `document_extracted` events.
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
| 09-10 | **Three silent deaths closed before the modular upload flow puts iPhone photos front and centre.** (1) **HEIC.** `ACCEPTED_MIME` listed `image/heic`, so iOS handed us the raw file; `anthropic.ts` cast the media type and sent it; the API answered 400; the queue retried the same 400 twice more and marked the row dead — the most likely real-world input, dying silently. HEIC is now *out* of the accepted list, which makes iOS Safari transcode to JPEG at the moment the photo is picked (the behaviour we want, for free); a desktop HEIC is refused at `/sign` with a message naming what we take; and the provider refuses any image type outside `jpeg/png/webp/gif` by name. (2) **Interrupted drains.** Nothing ever reclaimed a row left `running` by a function killed at Vercel's 300 s ceiling — the vision proof drained in 244 s. The claim now stamps `running_since` (migration `0008`, applied to prod first) and `runDueExtractions` reaps anything `running` past 10 minutes back to `failed` (or `dead` once attempts run out) with the reason, before the ordinary claim. (3) **Request ceilings.** Bytes were checked only when a *second* part was added, so a single 25 MB upload went out at 33 MB of base64; pages were never checked, so eight 20-page scans went out at 160 against a 100-page limit. `src/lib/call-limits.ts` weighs a chunk after the files are fetched — text-layer parts weigh nothing, a scan weighs its bytes and pages, an image is one page — and splits it into as many calls as fit (18 MB / 90 pages); a part that cannot fit alone raises `NonRetryableExtractionError`, as does any API 400 and any refused image type, and the queue marks those rows **dead on the first attempt** instead of after three identical answers. `check:call-limits` covers all of it and was broken six ways. **Reaper proven on production:** a row on lead `ecc46544` staged as `running` since 20 minutes ago; within 5 s of the next drain it read `attempts=1`, `last_error="reading interrupted — reclaimed after 10 minutes"`, `running_since` fresh; 41 s later `succeeded`, 6 fields, `attempts=2`. Not yet seen on production: a split group and a refused HEIC — the guard is the evidence for those today |
| 09-10 | **T3 closed — the vision path read the 57 scans that the text-layer gate had been starving it of.** Same lead (`ecc46544`), same 57 print-to-PDF files, same 13 groups, requeued and drained on production after B7 deployed. Before: 13 calls, `text_layer`, **0 fields**, $0.38. After: 13 calls, all `vision`, 301,762 tokens in / 99,787 out, **$1.60**, 244 s wall clock, **54 documents `succeeded`, 3 `empty`** — and all three empties are *correct*: a smoke-alarm placement diagram from a county permit, an Enphase production-dashboard screenshot, and a bank transaction register filed as a utility bill. The model read each, said what it was, and found nothing to assert; `empty` did exactly what it was built to do. 10 of 13 calls carried at least one value (55 tier-2 assertions across 13 distinct fields, every one at high confidence). The Truth-in-Lending chunk (8 files) came back with **13 fields**: 1.99% APR, the monthly payment, the amount financed, EnerBank USA, 2022. `documents.has_text_layer` is now `false` on all 57 with vision transcriptions of 255–4,219 chars where there had been 249 chars of print header. **This is also the first real handwriting through the pipeline (T1, partially):** 70 handwritten marks transcribed across six calls; `signer_name`, `signed_month` and `signed_year` were read from handwriting in 3–4 calls each. What T1 still owes is the displacement test — a handwritten value beating a printed one in `proposedFields` — which these files did not exercise. Cost to plan against: **$0.028 per scanned page-pair, ~$0.12 per vision call**, roughly 4× a text-layer read of the same document. On prompt caching (BACKLOG §0.5): the fixed prefix is ~7,800 of an average 23,200 input tokens on a vision call — a third, not the 98% measured on the empty text-layer calls — so caching would have saved ~$0.15 of this $1.60, not 75%. Still worth doing; no longer the headline |
| 09-10 | **B7 closed — the text-layer gate judges content, per page.** A scan printed to PDF from a browser carries ~249 characters a page of the browser's own print chrome (timestamp, filename, signed URL, `1/2`), which cleared `pdf.ts`'s 120-chars-per-page average by 2× and `anthropic.ts`'s absolute `> 200` outright — so 151 of 154 production documents were declared readable as text, the bytes were never sent, and 81 of 102 calls returned nothing. Length could never fix it: measured on the real files, a header page is 248–251 chars while a genuine 22-page contract's cover page is 221 and a DocuSign trailer is 170. What does not overlap is the residue after the chrome is stripped — **0 on every header page, ≥170 on every real one.** `src/lib/text-layer.ts` now strips the chrome and judges each page against a 40-char floor; a file is a text-layer document only when at most a fifth of its pages are unreadable (a two-page scan must be clean on both; a 22-page contract may carry four blanks), so the finding's 3-digital-plus-17-scanned hypothesis goes to vision instead of being read from three pages. Stripping is for judging only — the model still receives the page as extracted. `anthropic.ts` no longer re-decides by length: one gate, one rule, one module, imported by the guard rather than copied. Verified on the production bytes: all six retest scans → vision, pages [1,2] reported; Titan (22p), GoodLeap (21p), Douglin (22p) → text on every page. `check:text-layer` holds the verbatim production header as case 1 and was broken five ways — floor to 0, URL pattern removed, unreadable share to 90%, `anthropic.ts` back to `> 200`, `pdf.ts` back to `mergePages: true`. Migrations `0006`/`0007` were also found never applied to production and were applied this session: `empty=125, succeeded=30`. The *Extraction quality / mock* row above was stale — production has been `anthropic` / `claude-sonnet-5` since 09-10 (closed row below) — and is removed |
| 09-10 | **A reading that found nothing no longer reports success.** A model call returning all 25 fields null was written as `succeeded` — so `extractionProgress` counted it, `finished` went true, the homeowner was advanced, and `/review` had nothing to put in front of them. The call worked; the document was never read; one status meant both. There is now a terminal `empty` status, derived from `valueBearingFields()` in `src/lib/extraction-yield.ts` — the same predicate `proposedFields` uses to decide what `/review` can show, so "we read it" and "we can show it" cannot drift apart again. `empty` counts as **done but not succeeded**: `finished` still resolves, and `ReadingProgress` already routed `succeeded > 0 ? '/review' : '/apply/eligibility'`, so a homeowner whose files were all unreadable stops landing on a blank confirmation screen. They are now told which files could not be made out, and why. `check:extraction` covers it and was broken five ways — the predicate counting narrative fields, the empty-string sentinel passing as a value, the null guard removed, `queue.ts` reverted to a hardcoded `'succeeded'`, and `extractionProgress` folding `empty` back into `succeeded`. Migration `0007` reclassified **125 of 154 production rows** (81 billed calls, $1.94). This is the instrument, not the cure — the cause is B7 |
| 09-10 | **A deleted document stops counting.** `extractionProgress`, `proposedFields` and `hasAnyExtraction` read every extraction row for a lead, including rows on documents the homeowner had deleted — rows the worker never claims again. On production one lead carried 23 of them and reported 58 of 80 read, so `finished` could never become true and the reading screen waited out its whole ceiling; one value read from a deleted file was still being proposed on `/review`. All three now join `documents` on `deleted_at is null`, as the claim query already did; `hasAnyExtraction` was the third reader with the same gap, so a lead whose only documents were deleted is no longer sent to `/reading` to wait for nothing. Same lead now computes 57 of 57. Cost rows are untouched — a deleted document's reading was still paid for |
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
| 09-10 | **Contact details now reach the Calendly form.** The booking step passed name, email and phone to the widget's `prefill` option, and this version of Calendly's `widget.js` does nothing visible with it — a scratch embed given an explicit `{name, email}` produced an iframe whose URL carried `utm_*` and nothing else, so every homeowner has been retyping their name and email into the calendar. The same fields now go on the URL itself, which the widget preserves verbatim and Calendly's page reads as documented: the iframe carries `name=Dana+Rivera&email=dana.rivera@example.com&a1=+17025550134` beside `utm_content=lead:…`. The "open in a new tab" fallback used the bare event URL and lost the `utm_content` the webhook matches bookings on; it now uses the same prefilled URL. Found because Dakota asked whether the email could be routed in — it was wired, and arriving empty |
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
