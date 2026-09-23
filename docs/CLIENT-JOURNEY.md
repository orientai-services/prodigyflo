# Client journey — canonical

**Every SCS homeowner, every time.** No per-client filename branches. No one-off republish.

This file is the process. `docs/CANONICAL.md` is the production map (which GitHub / Vercel / domain). Do not merge the two apps or their databases.

| | Homeowner (SCS) | Staff (ProdigyFlo) |
|---|---|---|
| Job | Upload papers, Confirm what was read, answer money/credit, book | Use the profile |
| Site | solarcontractservices.com | prodigyflo.ai |
| Extractor | Document Intelligence + loan-map fence | No second OCR (`DOCUMENT_ANALYZER` unset) |
| Push | Review Confirm | Packet ingest + file copy + materialize |

Companion visual: `~/Developer/factory/2026-09-21_doc-extraction-population/LOGIC.md`.

---

## 1. What the homeowner walks

```
 Contact → Upload → Reading (gate, not numbered)
        → Review Confirm → Questions (money / credit / consent)
        → Booking (optional clock) → Confirmation
```

Numbered trail: Contact, Upload, Review, Questions, Booking, Confirmation.
Reading and Analysis stay gates. They are not extra numbered steps.

- **Confirm on Review is the ProdigyFlo push.** There is no extra Send.
- Blank Review boxes do not block continue. Only a proposed or typed value must be decided.
- Credit is the intake form. Never OCR a credit score.
- Booking is optional. A live clock still must land on the staff board.

---

## 2. What happens to every uploaded file

```
 Upload PDF
    |
    v
 Classify packet type     finance name → loan_or_til
                          install / solar agreement / PPA / lease → agreement
                          bill → utility_bill
    |
    v
 Prepare                  every page gets a JPEG (text pages too)
    |
    v
 Analyzer Worker          private prodigy-document-analyzer
                          never records.prodigyflo.ai
    |
    v
 Transcribe → Extract → Reconcile → Map → loan-map fence → Publish
    |
    +--> Review proposals
    +--> Packet to ProdigyFlo (files[] + analysis)
```

If a page is a photo, it is still rasterized. Skipping JPEGs because a text layer exists is not the path — Document Intelligence never starts without page images.

---

## 3. Packet type → staff tile (permanent)

Installer name is not a lender. Deal type `loan` (APR / amount financed) is how they pay, not which PDF this is.

| PacketDocType (SCS `files[].doc_type`) | PF requirement key | Tile |
|---|---|---|
| `agreement` | `solar_contract` | Solar contract / install agreement |
| `loan_or_til` | `finance_agreement` | Finance / lender agreement |
| `utility_bill` | `utility_bill` | Electric bill |

Finance **filenames** (GoodLeap, Mosaic, Sunlight, Loanpal, TILA, loan agreement, promissory note, finance agreement, closing certificate) beat install names.

An install / solar agreement filename stays `agreement` even when extract `agreement_type` is `loan`.

If the file is already in ProdigyFlo on the wrong requirement, **re-slot the same row**. Do not copy bytes twice.

---

## 4. Who may write which box

| Source | May write | Must not write |
|---|---|---|
| Install / solar / PPA / lease PDF | Installer, kW DC, product type, PPA monthly / escalator / cash price | Lender TILA fields as if this file were the loan |
| Lender / TILA / RIC PDF | Amount financed, APR, term, monthly, lender | kW, credit, dealer fee, utility amount-due |
| Utility bill | Utility name, usage, amount due | Solar monthly, APR, remaining |
| Completion certificate | First-pay (cert wins) | Invented cert from RIC clauses |
| Lender statement | Remaining, interest paid, time left (beats math) | |
| Intake form | Credit band | |
| Math | Dealer fee = `round(0.30 × amount financed, 2)`; remaining leftover since first-pay | PDF “dealer fee” line; remaining = page number |

**kW** is DC from watts (10,400 W → 10.4) or a labeled kW. Skip CEC-AC. Skip “shall not exceed 25 kW”. Do not treat a $1,000 deposit as watts. Missing → Not in paperwork.

**APR ≠ escalator.** Loans show Interest rate from APR. PPA/lease shows Annual escalator, never in the APR box.

**First-pay:** completion cert wins. If there is no cert, customer signing / envelope date is first-pay, then remaining amortizes. PPA remaining is leftover scheduled payments, not loan principal. Drop junk remaining (page “2”, legalese).

**Remaining** is leftover of amount financed (or PPA schedule) since first-pay. It is not a payoff quote.

---

## 5. Always-on handoff (no republish)

```
 Review Confirm
    |
    v
 SCS enqueue + kickDispatch
    |
    v
 PF processInbound          metadata only (20s lock — no S3, no AI)
    |                       upsert Client on scs:{leadId}
    v
 after()                    copy this client's files (max 5)
                            materialize SCS analysis (no Anthropic)
    |
    v
 Profile tiles + FinalDesk  unverified extracts may show
                            staff VERIFIED / CORRECTED / REJECTED stay locked
```

Same SCS `sourceDocumentId` never becomes a second ClientDocument.

Webhook stays metadata-only. Cron `/api/jobs/run` is retry.

---

## 6. Booking clock

```
 Widget postMessage → bookings row
    |
    +-- scheduled_at missing + CALENDLY_API_TOKEN
    |      after() fetch event start/end (do not invent time)
    |      republish + kickDispatch
    |
    v
 Calendly invitee.created webhook is authority
    match lead:uuid then email
    write scheduled_at, republish, kickDispatch
    |
    v
 PF parseIntakeBooking needs data.booking.scheduled_at
    upsert Appointment (imported)
    a sticky CONFLICT receipt must not block a later clocked packet
```

---

## 7. Property records (separate pipe)

Deed / UCC / permit originals may land on their tiles. Search-summary PDFs are **Other**, never the original. UCC CAPTCHA must not block OCR, Review, or booking.

---

## 8. Never

- Per-client or per-filename special cases (no named-homeowner branches)
- Second OCR in ProdigyFlo on an SCS file
- Analyzer host `records.prodigyflo.ai`
- Invent kW, remaining, first-pay, or credit
- Mix APR and escalator
- Treat an installer name as a lender
- Send an install PDF to `finance_agreement` because the deal is a loan
- Skip JPEGs for text-layer pages
- Duplicate storage bytes to “fix” a wrong tile
- One-off republish as the default path
- Merge SCS and ProdigyFlo repos or databases
- Extra Vercel deploy after merging `main` (GitHub connection deploys)

---

## 9. How this stays true

SCS: `npm run check:client-journey` (wired into `npm run check`).
ProdigyFlo: `src/lib/intake/client-journey.check.test.ts` (wired into `npm test`).

If a future change breaks the trail, the packet router, the tile map, the JPEG rule, the dealer-fee math, or the always-on kick, those guards fail in CI.
