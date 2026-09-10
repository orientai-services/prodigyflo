# BACKLOG — open decisions, modifications, and tests owed

Companion to `STATUS.md`. That file records what is *blocking* and what is *done*;
this one holds work that is known, agreed and not yet started, plus the decisions
still owed before some of it can be.

Update in the same commit as the work. When an item ships, move a one-line entry
into the STATUS.md closed table and delete it here.

**Last updated:** 2026-09-10

---

## 1 · Tests owed

Things built but not yet proven against reality. Each one is a place where the
code looks right and has never met the case it was written for.

| # | Test | Why it matters | Blocked on |
|---|---|---|---|
| T1 | **Handwriting detection against a real document.** The schema, ranking, storage and UI all ship, but no document with actual handwriting has ever been run through it. | The whole feature is untested against its purpose. A scan with margin notes, a struck-through figure, or a number changed by hand would exercise: does the model find it, transcribe it verbatim, set `alters_printed` correctly, and does a handwritten value actually displace the printed one in `proposedFields`? | a real scan with handwriting on it |
| T3 | **Vision path.** `input_mode: 'vision'` has never run — every test used a text-layer PDF. Phone photos of paperwork are the common case and take a different code path. | The most likely real-world input is the least tested one. | photos of a real agreement |
| T5 | **The ProdigyFlo CRM, at all.** `/login` returns 200 and nobody has ever signed in. The SCHEMA_42 packet panel, closer-win brief and READY gating are unverified end to end. | Half the product has never been looked at. | nothing — just needs doing |
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
- **A deleted document's readings still count.** `proposedFields` selects on
  `lead_id` and `status='succeeded'` and never joins `documents`, so a value
  read from a file the homeowner removed keeps being proposed and confirmed.
  `extractionProgress` has the mirror-image problem: it counts every extraction
  row for the lead, including ones on deleted documents that the worker will
  never pick up (it filters `deleted_at is null`), so `finished` can never
  become true and the reading screen waits out its whole ceiling. Live on
  production right now: one lead carries 22 such rows. Both are one join.
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
