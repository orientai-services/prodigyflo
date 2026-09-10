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
| T2 | **Extraction against a genuine solar contract.** Only ever run against a synthetic 964-byte PDF I generated. It read that one well, but a real agreement is 20+ pages, often a phone photo, and full of the boilerplate the fields have to be found inside. | Field coverage on a real document is unknown. The mirror is only as good as this. | a real contract PDF or photos |
| T3 | **Vision path.** `input_mode: 'vision'` has never run — every test used a text-layer PDF. Phone photos of paperwork are the common case and take a different code path. | The most likely real-world input is the least tested one. | photos of a real agreement |
| T4 | **Malformed-JSON retry.** Extraction moved off strict structured output to JSON-in-text, relying on the queue's `attempts` / `next_attempt_at` backoff when a reply will not parse. That retry has never been observed firing. | It is the safety net for the change that made extraction work at all. | force a bad reply, or wait for one |
| T5 | **The ProdigyFlo CRM, at all.** `/login` returns 200 and nobody has ever signed in. The SCHEMA_42 packet panel, closer-win brief and READY gating are unverified end to end. | Half the product has never been looked at. | nothing — just needs doing |
| T7 | **Batch upload against a real multi-page contract.** Proven with a 3-page synthetic split across three files. A real one is 20+ pages, so the conflict rate below scales with it. | The failure mode found in D7 gets 20x more likely, and phone photos arrive out of order. | a real contract, photographed page by page |
| T6 | **Cross-document identity verification** (see D3) once implemented. | It is fraud/eligibility logic; a false negative lets a mismatched name through. | D3 decided, then built |

## 2 · Open decisions

| # | Decision | Context | Owner |
|---|---|---|---|
| D1 | **Does `utility_bill` stay in the upload list?** The narrowing on 2026-09-10 named three documents to gather (agreement, loan document, PTO letter) and five to remove. Electricity bills were in neither list, so they were kept — the mirror's payment-vs-bill arithmetic and the 6-before/12-after window both depend on them. | Confirm the read, or drop it and remove the window logic with it. | Dakota |
| D2 | **What ProdigyFlo becomes.** Closers, READY and Strawberry submitting to CYS/attorney were built to fulfil cancellations. Under referral, "Submit" is a handoff and "closer" is an advisor. | Staff train on the old vocabulary until this is settled. | Dakota |
| D3 | **Shape of cross-document identity verification.** The requirement (`SCS - INTAKE - AI ANALYSIS DOCS - IMPORTANT .rtf` on `main`): first name, last name and home address verified against the intake form on every document; utility bill is the only *name* exception (may be a spouse's); **address must match across all documents**. `signer_name` and `address_line1` are now extracted with quotes, so the anchor exists. Open: what happens on a mismatch — flag to staff, ask the homeowner, or block? | Real fraud/eligibility logic. Deciding the failure behaviour is the hard part, not the comparison. | Dakota |
| D7 | **What happens when two uploaded pages disagree.** Multi-file upload made this common: one contract photographed page by page becomes N documents, each extracted alone. A 3-page test produced two conflicts, both at `high` confidence on both sides — page 3's header read as `ppa` where pages 1–2 read `loan`, and a "monthly payment after month 18" line read as the monthly payment. `proposedFields` folds them into one value per field and `beats()` returns false on a tie, so **the earliest upload wins**. It is stable (ordering is total as of `ac9f7bd`) but arbitrary: photograph the pages in a different order and the homeowner is shown `ppa` and `$205` as high-confidence fact, with one citation and no sign the other reading exists. Options: surface the conflict on `/review` and make the homeowner pick; prefer the document whose page carries the most corroborating fields; or keep first-wins and accept it. | This is the mirror's own principle at stake — it restates a homeowner's documents, and here it would restate one of two contradictory readings without saying so. Not a bug in the merge; a question the merge was never asked before. | Dakota |
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
