# BACKLOG — open decisions, modifications, and tests owed

Companion to `STATUS.md`. That file records what is *blocking* and what is *done*;
this one holds work that is known, agreed and not yet started, plus the decisions
still owed before some of it can be.

Update in the same commit as the work. When an item ships, move a one-line entry
into the STATUS.md closed table and delete it here.

**Last updated:** 2026-09-10 (fourth checkpoint — B7 and T3 closed; the reader reads scans)

---

## 0 · Checklist

The open items, in the order to take them. Each points at its row below; tick
here when the row is deleted and the closed line lands in STATUS.md.

**Before real traffic**
- [ ] [01a09105] Counsel-owned: set the retention/deletion schedule and external-recipient policy for ProdigyFlo case packages. The case-file import is live; this is policy, not a release blocker.
- [x] ~~B7 — the text-layer gate~~ — closed 09-10, STATUS.md §3. Scans reach vision now.
- [x] ~~T3 — the vision path~~ — closed 09-10, STATUS.md §3. 54/57 read, 3 correctly empty, $1.60.
- [x] ~~`check:env` guard~~ — shipped 09-11, STATUS.md §3. Run it against the pulled prod env before every deploy that touches env or migrations. **It currently fails prod on B6** (connector token is the seeded dev value) — that is the guard working.
- [ ] D9 to counsel — the balance-floor sentence, verbatim from STATUS.md.
- [ ] D10 to counsel — the AI-drafted account; decide whether ProdigyFlo needs a `narrative_drafted` flag.
- [ ] Calendly event `cancel-your-solar-contract-review`: confirm the first custom question is the phone, or phone lands nowhere (§3 *Phone prefill lands in a1*).
- [ ] T8 — watch the first real booking: prefilled form, webhook match.
- [ ] B3 Resend, B4 Turnstile, B5 fake clients, B6 token rotation (STATUS.md §0).

**Correctness, known and bounded**
- [ ] **Malformed model JSON kills a readable contract.** 2026-09-10, local walk: the 22-page Titan
      agreement (text layer, read cleanly for 11 fields an hour earlier) failed attempts 1 and 2 with
      `extraction returned invalid JSON: Expected ',' or ']' after array element` at positions 6892
      and 5607 — an unescaped character inside an array of strings, almost certainly a `handwriting`
      transcription of a contract full of `"` and `___` marks. Three strikes → `dead`, and a digital
      contract yields nothing. Options, cheapest first: (a) log the 200 chars around the parse
      position so the next one is diagnosable; (b) a repair pass before giving up (strip control
      chars, escape a lone `"` inside a string, close an open array) — repair, then validate with the
      same zod schema, never trust the repair; (c) ask for `handwriting` as a separate call when the
      main parse fails. Measure the rate first: `select count(*) from extractions where last_error
      like 'extraction returned invalid JSON%'`. Related: the reading screen no longer counts a
      `failed` (retry pending) row as done — that was letting attempt 1's bad reply tell the
      homeowner nothing could be read while attempt 2 succeeded behind them.
- [ ] `first_payment_month` field, extracted and confirmed, so the payment count survives deferrals (§3 *The payment count assumes…*).
- [ ] Per-lead cap on narrative drafts (§3 *Narrative drafting has no per-lead cap*).
- [ ] Cap on batch upload size, with the count shown before it starts (§3 *No cap on batch size*). Soft cap, decided 09-10: show the count, warn above ~24 files, never block — a 20-page contract photographed page by page must still fit one module. Lands with the modular upload flow below.
- [ ] **Modular upload flow** (decided 09-10: D-1a review-delta, D-2a soft cap, D-3a breakpoints first — done). One document type per module at `/upload/[docType]`; `/reading` scoped to that type; `/review` shows only proposals not yet in `field_reviews`; back to a hub (`/upload` pre-form, `/portal` post-form, one component) that renders the mirror over *confirmed* values, a "still to confirm" count, and each remaining gap as an "upload this next" card linking to its module. Reuses `DocumentUploader` rows, `ReadingProgress` (now page-weighted, 09-10 — per module it reads "16 pages of *this* upload"), `ReviewForm`, `Findings`, `GapActions`, `neededDocuments()`. New: hub state per type, `extractionProgress(lead, docType)` (the SQL already groups by type; scoping is a `where`), the review delta. The planned document-retrieval modules (§1) live on the module page.
- [ ] Grouping vs a lead's history — supersede or fold (§3 *Grouping fixes a batch…*). Decision, not a bug.

**From DOCUMENT-PROCESSING-REVIEW.md (09-11) — Slice A shipped; these are the rest, in the review's order**
- [ ] **B7 · Shrink phone photos in the browser** before the PUT: `createImageBitmap` → canvas long edge ≤ 2000 px → JPEG 0.82. A 12 MP iPhone photo is 3–6 MB; the API sees 1568 px of it. Today three photos fill an 18 MB call and a 20-page contract becomes 3–7 calls that can disagree. No HEIC decoding (LGPL wasm; the accept-list trick already makes iOS transcode). Manual check: 20 photos → `groups: 1`.
- [ ] **B8 · Sniff, hash, detect encryption at confirm** — the bytes are already fetched for the page count. `file-type` magic bytes (store the sniffed `mime`, log disagreement), `sha256` → `documents.sha256` (same lead + hash → return the existing row, no second read), `PasswordException` → `unreadable_reason='password'` + a homeowner message at upload rather than "the reader refused the file" after the drain. Guard fixtures: renamed PDF, encrypted PDF, duplicate.
- [ ] **C10 · Eval harness** — `scripts/eval-extraction.mts` over a private bucket prefix of labelled cases (`expected.json` per document); scores per field by `doc_type × input_mode`, totals cost. Seed with the 57 T3 files + Titan/GoodLeap/Douglin. **Dakota labels ~10 cases (~1 h).** Before any further prompt or model change. **Labelling kit built 09-11:** `~/Developer/~SCS~/eval-labels/` — outside every repo (real homeowner documents) — 10 cases, 24 files, `expected.json` per case to fill, `reader.json` per case to check against afterwards, `HOW-TO-LABEL.md`. Cases 09/10 are the deliberately-empty ones. The harness reads `expected.json`; the files go to a private bucket prefix, never the repo.
- [ ] 11 · Structured outputs re-test (`output_config.format`; the wire schema has zero unions) or a Haiku repair step for malformed JSON. Prod rate 0/178; local 2 tonight. Measure with C10 first.
- [ ] 12 · Identity comparator (D3) as code: `account_holder_name` field, `src/lib/identity.ts` normalisers, one T2 assertion per document, mismatch surfaced never blocked. Needs the hub for its card; the public-records owner of record is the third anchor.
- [ ] 13 · Message Batches API (50% off) for the cron / prep-step path only. · 14 · Gemini Flash as a second `ExtractionProvider`, eval only. · 15 · Storage lifecycle (trash prefix + 30-day expiration; a retention decision for live documents).

**Staged, awaiting ingest**
- [ ] **Public records module** — `modules/public-records/`, staged 09-10, not imported anywhere,
      excluded from deploys by `.vercelignore`. Fires when the address is identified; gives
      county / APN / owner of record / recorder + assessor + permit deep links (free fetches in
      Clark NV, Maricopa AZ, FL SOS). **Owner of record is the anchor D3 has been missing.**
      Port the ~350-line resolver to TS, keep the registry JSON as data, land results as tier-2
      assertions, fetched documents as ordinary `documents` rows queued for extraction. Spec and
      checklist: `modules/public-records/PLUG-IN.md`. Smoke-tested the day it was staged.

**Decisions still owed**
- [ ] D1 `utility_bill` stays? · D2 what ProdigyFlo becomes · D3 cross-document identity (see the staged public-records module — the assessor's owner of record is the name to compare `signer_name` against) · D4 compensation disclosure · D5 provider registry · D6 money/experience steps.

**Tests owed**
- [ ] T1 handwriting displacement (marks are found now; a handwritten value beating a printed one in `proposedFields` is not yet seen) · T5 sign into ProdigyFlo at all · T7 batch vs a real 20-page contract · T9 narrative rewrite rate · T6 identity verification once D3 is built.

**Accounts**
- [ ] Supabase: the live SCS project (`vspmjtdwlcqfclkgksel`) sits in an org the Claude connector cannot see, while an empty `scs-intake-prod` sits in the one it can. Consolidate before it bites in an incident.

## 0.5 · Efficiency, measured and waiting

- [x] ~~Prompt caching on the extraction prefix~~ — shipped 09-11, STATUS.md §3: 7,487–7,718
      tokens read from cache per call after the first, priced at 0.1×, on the event, with a
      warning when a later call reads zero. The headline turned out to be **thinking**, not
      caching or transcription: see the 09-11 row. The eval harness (C10) is what turns
      `EXTRACTION_THINKING` into a measured curve instead of an n=2 choice.
- [ ] **PDF-Extract-Kit — evaluated 2026-09-10, declined.** AGPL-3.0 (inherited from YOLO and
      PyMuPDF, so not casually relicensable), Python + GPU so it cannot run in a Vercel
      function, and it solves a harder problem than ours (formula and table recognition for
      scientific PDFs). Worth borrowing conceptually, not as a dependency: decide *before* you
      read (layout classification, not `length >= 120`) and work **per page** — `readPdfText`
      uses `mergePages: true` and makes one verdict for a whole file. If local OCR is ever
      genuinely wanted, evaluate **MinerU** instead and check its licence first rather than
      assuming it differs.

## 1 · Tests owed

Things built but not yet proven against reality. Each one is a place where the
code looks right and has never met the case it was written for.

| # | Test | Why it matters | Blocked on |
|---|---|---|---|
| T1 | **Handwriting displacement.** Half-proven 09-10: the T3 run transcribed 70 handwritten marks across six vision calls, and `signer_name`, `signed_month`, `signed_year` were read from handwriting at high confidence. Not yet seen: a handwritten value and a printed value for the same field in one lead, so the `beats()` rule in `proposedFields` — handwriting outranks print — has still never fired on real data. | The ranking rule is the part that changes what a homeowner is shown, and it is the part untested. | a scan where a printed figure was changed by hand |
| T5 | **The ProdigyFlo CRM, at all.** `/login` returns 200 and nobody has ever signed in. The SCHEMA_42 packet panel, closer-win brief and READY gating are unverified end to end. | Half the product has never been looked at. | nothing — just needs doing |
| T8 | **The first real Calendly booking arrives prefilled and matched.** The iframe URL now carries `name`, `email`, `a1` and `utm_content=lead:<id>`; what was verified is the URL, not the filled-in boxes, which live in a cross-origin iframe behind a time-slot pick. The first genuine booking proves both halves: name/email already in the form, and the webhook matching it to the lead. | Every booking before 2026-09-10 was retyped and any fallback-link booking was unmatched. | a real booking |
| T9 | **Narrative filter rewrite rate.** `narrative_drafted` events carry `attempts`; a run of 2s means the model keeps reaching for banned words and the prompt needs work, and a homeowner with an honest "they promised a refund" tile trips it too (the filter over-blocks `refund`/`owed`/`void` as whole words, deliberately). | The filter is the guarantee; its false-positive rate is unmeasured. | ~50 real drafts |
| T7 | **Batch upload against a real multi-page contract.** Proven with a 3-page synthetic split across three files. A real one is 20+ pages, so the conflict rate below scales with it. | The failure mode found in D7 gets 20x more likely, and phone photos arrive out of order. | a real contract, photographed page by page |
| T6 | **Cross-document identity verification** (see D3) once implemented. | It is fraud/eligibility logic; a false negative lets a mismatched name through. | D3 decided, then built |

## 2 · Open decisions

| # | Decision | Context | Owner |
|---|---|---|---|
| D1 | **Does `utility_bill` stay in the upload list?** The narrowing on 2026-09-10 named three documents to gather (agreement, loan document, PTO letter) and five to remove. Electricity bills were in neither list, so they were kept — the mirror's payment-vs-bill arithmetic and the 6-before/12-after window both depend on them. | Confirm the read, or drop it and remove the window logic with it. | Dakota |
| D2 | **What ProdigyFlo becomes.** Closers, READY and Strawberry submitting to CYS/attorney were built to fulfil cancellations. Under referral, "Submit" is a handoff and "closer" is an advisor. | Staff train on the old vocabulary until this is settled. | Dakota |
| D3 | **Shape of cross-document identity verification.** The requirement (`SCS - INTAKE - AI ANALYSIS DOCS - IMPORTANT .rtf` on `main`): first name, last name and home address verified against the intake form on every document; utility bill is the only *name* exception (may be a spouse's); **address must match across all documents**. `signer_name` and `address_line1` are now extracted with quotes, so the anchor exists. Open: what happens on a mismatch — flag to staff, ask the homeowner, or block? | Real fraud/eligibility logic. Deciding the failure behaviour is the hard part, not the comparison. | Dakota |
| D10 | **An AI first draft of the homeowner's own account — is that acceptable to counsel?** What ships: the draft is built only from tiles the homeowner picked and facts they already gave, is filtered for characterising language, proposes no remedy, and becomes their statement only after they edit it and press Next. It is materially a suggestion in a text box. But the narrative field is delivered to ProdigyFlo as the homeowner's account, and a reviewer there cannot tell a typed sentence from an accepted draft. If counsel wants the distinction preserved, a `narrative_drafted` flag on the lead (the event already exists) is a one-column change. The prompt and the filter are in `src/server/narrative.ts` and `src/lib/plain-language.ts` for review. | Real-traffic gate, same category as D9. | Dakota + counsel |
| D9 | **Is the balance floor acceptable under "never invent remaining principal"?** The handoff forbids inventing a remaining balance. What ships is a subtraction over the homeowner's own confirmed numbers — amount financed minus months × payment — shown only when the document states no balance, with its assumption in the sentence and framed as the lowest the balance could be. It is arithmetic, not a stated balance, and the guard enforces every part of that framing. But it is the closest the product has come to that line, and counsel should see the exact sentence before real traffic. If the answer is no, deleting one `items.push` in `mirror.ts` removes it and the payment count stays. | The sentence is quoted in STATUS.md. | Dakota + counsel |
| D4 | **Compensation disclosure.** Providers pay per referral; current copy deliberately says "a provider that handles cases like yours" rather than "the best provider for you" — an introduction, not a ranking, which needs no disclosure to stay honest. If the copy ever strengthens to a recommendation, a disclosure has to appear with it. | Revenue model is not final. | Dakota + counsel |
| D5 | **Provider registry.** Partners are unofficial and unsigned. Nothing names a provider anywhere yet, deliberately. | Blocks the introduction step at the end of the journey. | Dakota |
| D6 | **`money` and `experience` steps.** `flows.ts` does not require either before booking, but both are presented as mandatory-feeling steps. Two of the five longest screens are optional. | Collapsing them is the single biggest completion-rate lever in the funnel. | Dakota |

## 3 · Modifications known and not yet made

- **Portal URLs are all dark.** All 15 entries in `src/config/retrieval.ts` are
  `verified: false`, so no portal link renders — deliberately, because a wrong
  login page costs more than the document. To light one up: open it, confirm
  where documents live, fill `url`/`where`, flip the flag. `check:retrieval`
  fails if a URL appears without the flag.
- **Yahoo and iCloud mail search** fall back to written instructions;
  `mailSearchUrl` returns null for both. Fine, but the instructions are not
  written yet.
- **Phone prefill lands in Calendly custom answer `a1`.** That fills the
  booking form's phone box only if the event type's FIRST custom question is
  the phone number. If it is not — or the event uses "invitee provides a
  number" as the call location — the phone arrives in the wrong field or
  nowhere. Confirm in the event settings for
  `cancel-your-solar-contract-review`. Name and email are standard Calendly
  parameters and do not depend on this.
- **Narrative drafting has no per-lead cap.** Each press is one Sonnet call
  (~700 tokens in, ~120 out, roughly a cent). The route is rate-limited to 12
  a minute per IP and nothing else. Fine for a homeowner; a script could spend
  a dollar a minute. A cap of, say, five drafts per lead would close it.
- **The narrative filter over-blocks a few honest words.** `refund`, `owed`
  and `void` are banned as whole words so the model cannot write "I am owed a
  refund"; the cost is that "they promised a refund" — a restatement of what
  was said — also trips it and triggers a rewrite. Acceptable while the draft
  is a suggestion; worth revisiting if rewrite rates in `narrative_drafted`
  events run high.
- **The payment count assumes payments began the month after signing.** Solar
  loans commonly defer the first payment 12–18 months (the fixture itself
  carries a "monthly payment after month 18" line). The sentence says "if a
  payment has been made every month since", which is honest, but a homeowner
  in a deferral window will read a count that is too high. A `first_payment_month`
  field, extracted and confirmed like the rest, would make the count exact.
- **Grouping fixes a batch, not a lead's history.** A group is what is read
  together; anything already read stays as it was. So a lead carrying two
  genuinely different agreements — an old contract read before grouping, and a
  new one uploaded after — still folds them, and the older reading wins a
  confidence tie. Seen on production during the deploy check: a test lead
  holding two readings of one contract and three files of another still showed
  the older `ppa`. On a real homeowner's lead, which has one contract and no
  history, this does not arise. Fixing it properly means treating a doc_type's
  readings as superseded when a newer group covers it, which is a decision
  about intent, not a bug.
- **Two chunks of one group can still disagree.** A group larger than
  `EXTRACTION_MAX_PARTS` (8) is split across calls, and two chunks of one
  contract can contradict each other exactly as two files used to. It is the
  honest limit of the design: an ordinary contract is never split, forty phone
  photos are. Raising the cap trades against request size and latency.
- **The model now resolves conflicts, and can resolve one wrongly.** On the
  three-page fixture it read `monthly_solar_payment` as 205.00 — the "after
  month 18" figure on page 3 — rather than the 189.00 on page 2. Upload order
  used to pick 189 by luck. Grouping replaced an arbitrary answer with a
  reasoned one, which is the right trade, but it is not the same as infallible;
  a real escalating payment needs the field to distinguish first payment from
  later ones.
- **Nothing checks that production's env matches what the code needs.** The
  extraction provider sat on `mock` in production from deploy until 2026-09-10
  because step 1 of a plan was applied locally and never to Vercel, and no
  guard, log line or health route would have said so. `EXTRACTION_PROVIDER`,
  `ANTHROPIC_API_KEY`, `RESEND_API_KEY` and the Turnstile keys are all in this
  category. A `/api/health` route reporting which provider is live, or a
  `check:env` in the guard set that reads `vercel env ls`, would have caught it
  the same day.
- **`EXTRACTION_CONCURRENCY` is unset, so drains run 4 at a time.** At the
  observed ~20s per document that is about 60 documents inside the five-minute
  ceiling. Raise it if batches routinely run larger; it takes no deploy.
- **No cap on batch size.** A homeowner can select 50 photos in one go; that is
  50 sequential presign→PUT→record round trips and 50 model calls at roughly
  $0.03 each. Nothing warns them or us. Worth a soft limit with a count shown
  before the batch starts.
- **Inline upload from a gap card.** Gaps name the document and offer email
  search; they cannot yet accept the file in place. Touches the upload
  component's state.
- **ProdigyFlo internal language** — closer → advisor, READY → referral-ready,
  Submit → handoff. Gated on D2.
- **Marketing site sweep.** `src/config/marketing.ts` and `content.ts` were only
  spot-fixed during the reframe.
- **Fade-in performance.** Every screen transition animates slowly enough that
  automated clicks repeatedly landed on invisible elements; a real user on a poor
  connection feels the same delay.
- **`documents.has_handwriting` has no reader.** The column and index exist so a
  reviewer can ask "which files were amended by hand", but nothing queries them
  yet — that is a ProdigyFlo surface.

## 4 · Notes for whoever picks this up

- Four guards run under `npm run check`: `check:prerender`, `check:copy`,
  `check:mirror`, `check:retrieval`. They are not decoration — each has caught a
  real defect, including one where the mirror guard had silently stopped
  covering four statements it was supposed to check.
- The mirror never assesses. It restates a homeowner's own documents and does
  arithmetic on them. The banned-word list governs sentences *we* compose;
  transcribed handwriting is evidence and passes through intact.
- `src/components/ReviewForm.tsx` is CRLF. Edits that assume LF will not match.
