# Existing field destinations and Records recovery contract

Recovery implementation dated 2026-09-20. This is a source mapping, not a claim of live acceptance. No profile/questionnaire definitions are added or changed. Current test case: Ashleigh's one original nine-page scanned agreement; do not run or change Marvin.

## Common evidence and correction rules

`records.v1` identifies source lead, manifest ID and increasing version, increasing evidence revision, analyzer version, contact/property fingerprint, original file hash, run ID, physical page and quote. A value lacking support stays null. Disagreeing candidates stay unresolved until a recorded customer decision. Customer review remains distinct from staff verification. Imported originals are checksum checked and the SCS evidence is materialized without another extraction.

Ordering is `(manifest_version, evidence_revision)`, never delivery ID or contact activity timestamp; a newer evidence revision wins even when contact activity is older or unchanged. An older identity/manifest cannot populate the current property. New manifests hide previous automatic suggestions; immutable history and explicit staff corrections/rejections remain. Deliberate blank corrections are not permission to restore earlier automatic values. Existing staff questionnaire `_manual` decisions always win over imported answers.

All monetary values are USD; APR and escalation are percentages, never interchangeable. Term years convert to months only from an explicit numeric year count. Derived amounts require their documented/reviewed inputs. Unknown and Not applicable are not zero or No. No model infers homeowner testimony from contractual clauses.

## Fixed 17 profile cells

| Existing destination | Source / unit | Meaning and unavailable behavior |
|---|---|---|
| Total / amount financed | loan `amount_financed`, USD | Loan principal; PPA/lease N/A |
| Remaining balance | quoted `remaining_balance`, USD; otherwise reviewed loan amortization | Preserve statement/source qualification; estimates labeled; no supported inputs → cannot compute |
| Interest rate | loan `apr`, percent | Never escalation; PPA/lease N/A |
| Interest paid to date | reviewed first-payment date + loan term/APR/payment | Estimate, not payment history; unsupported → cannot compute |
| Annual Escalator Rate % | solar `escalator_pct`, percent | Annual payment increase, never APR; absent → Unknown |
| Term years | stated term years, or explicit term months / 12 | No term inferred from signing date |
| Term months | `term_months`, or stated `term_years` × 12 | Source retained and conversion labeled |
| Years remaining | reviewed loan first-payment date and term | Unknown when actual start/inputs unknown; PPA/lease cannot compute |
| Months remaining | same reviewed loan inputs | Same restrictions |
| Monthly payment | supported current/stated `monthly_payment`; separately qualified first-year PPA amount | First-year amount explicitly labeled, never silently called current |
| 30% Dealer Fee | amount financed × 0.30 | Existing internal benchmark label, not documented dealer fee; PPA/lease N/A |
| Lender | loan `lender_name` | PPA counterparty remains evidence, not a lender; servicer distinct |
| First payment date | loan `first_payment_date` | No signing/effective/PTO substitution |
| Agreement type | explicit `product_type` → loan/lease/PPA/cash | No unsupported guess |
| Installer | unconditional `installer_name` from either contract type | Sales company, optional subcontractor and lender are distinct |
| Credit score | client-reported actual three-digit score | Credit range stays range evidence, cannot become a numeric score; no bureau inference |
| System size | `system_size_kw` from solar/finance/production evidence, kW | Unknown if absent; source retained |

## Existing 42 questionnaire IDs

Every canonical ID is accepted from SCS `stage1_answers` with its existing option values. Supplemental SCS collection uses the existing journey stages. `_scs_questionnaire_dispositions` persists explicit `answered`, `unknown`, or `not_applicable`; explicit missing dispositions suppress stale prefill. A staff override still wins. Empty controls reflect Unknown/N/A rather than invented testimony; imported disposition remains stored in the intake response.

| Existing ID | Allowed source / specific rule |
|---|---|
| legal_name | Contact; staff correction wins |
| prop_addr | Contact property address; never seller address |
| mail_same | Customer testimony only |
| phone | Contact |
| email | Contact |
| sole_owner | Customer testimony; parcel owner does not prove sole ownership |
| on_contract | Evidence-backed signer names, then customer confirmation |
| prop_type | Customer testimony |
| sales_co | Quoted sales company or customer answer |
| install_co | Actual installer evidence or customer answer |
| lender | Loan lender evidence or customer answer; never PPA counterparty |
| agree_type | Explicit contract type or customer answer; existing option labels |
| year_signed | Customer signature date year, not effective date |
| sign_where | Customer testimony |
| notice_3day | Customer testimony; clause presence does not prove receipt |
| got_copies | Customer testimony |
| first_contact | Customer testimony |
| pres_where | Customer testimony |
| pres_len | Customer testimony |
| pressure | Customer testimony; exclusive None |
| promises | Customer testimony; exclusive None |
| misled | Customer testimony |
| untrue | Customer testimony |
| mo_pay | Supported payment plus period qualification; current amount customer-confirmed |
| term_yrs | Explicit years or months converted with unit annotation |
| escalator | Explicit escalation >0 → Yes, explicit zero → No; absent → Unknown |
| combo_bill | Customer testimony |
| told_lower | Customer testimony |
| working | Customer testimony, not predicted production |
| perf | Customer testimony; exclusive no-issues choice |
| install | Customer testimony; exclusive no-issues choice |
| service | Customer testimony; exclusive no-issues choice |
| oob | Customer testimony; no corporate-status inference |
| complaints | Customer testimony; exclusive None |
| selling | Customer testimony |
| sale_issue | Customer testimony |
| ucc | Customer testimony / actual retrieved filing for staff review; filing fee clause is not a recorded UCC |
| age | Customer testimony |
| le | Customer testimony |
| credit_ck | Customer testimony; agreement authorization is not proof of a credit pull |
| hardship | Customer testimony; exclusive No hardship |
| goal | Customer testimony |

## Existing CYS / schema42 destinations

`prisma/seeds/cys.ts` remains authoritative; no seed/schema business definitions changed. CLIENT_FIELD and ADDRESS_FIELD entries resolve from Contact. SURVEY_ANSWER entries resolve from their current exact sourcePath, preserving homeowner provenance. DOCUMENT_FIELD entries resolve from immutable evidence and explicit staff review. Existing manual/operational entries remain manual or their existing rules; unknown operational values are not manufactured by OCR.

| Existing CYS key | Exact existing source | Rule |
|---|---|---|
| first_name | CLIENT_FIELD: `client.firstName` | Existing source; missing stays Unknown |
| last_name | CLIENT_FIELD: `client.lastName` | Existing source; missing stays Unknown |
| phone | CLIENT_FIELD: `client.phone` | Existing source; missing stays Unknown |
| email | CLIENT_FIELD: `client.email` | Existing source; missing stays Unknown |
| property_street | ADDRESS_FIELD: `address.line1` | Existing source; missing stays Unknown |
| city | ADDRESS_FIELD: `address.city` | Existing source; missing stays Unknown |
| state | ADDRESS_FIELD: `address.state` | Existing source; missing stays Unknown |
| zip | ADDRESS_FIELD: `address.postalCode` | Existing source; missing stays Unknown |
| mailing_same_as_property | SURVEY_FIELD: `survey.mailing_same_as_property` | Existing source; missing stays Unknown |
| owner_of_record | SURVEY_FIELD: `survey.owner_of_record` | Existing source; missing stays Unknown |
| sale_or_refi | SURVEY_FIELD: `survey.sale_or_refi` | Existing source; missing stays Unknown |
| pain_type | SURVEY_FIELD: `survey.pain_type` | Existing source; missing stays Unknown |
| pain_narrative | SURVEY_FIELD: `survey.pain_narrative` | Existing source; missing stays Unknown |
| product_type_guess | SURVEY_FIELD: `survey.product_type_guess` | Existing source; missing stays Unknown |
| lender_guess | SURVEY_FIELD: `survey.lender_guess` | Existing source; missing stays Unknown |
| monthly_guess | SURVEY_FIELD: `survey.monthly_guess` | Existing source; missing stays Unknown |
| installer_guess | SURVEY_FIELD: `survey.installer_guess` | Existing source; missing stays Unknown |
| how_signed | SURVEY_FIELD: `survey.how_signed` | Existing source; missing stays Unknown |
| doc_contract | DOCUMENT_FIELD: `document.solar_contract.installer_name` | Existing source; missing stays Unknown |
| doc_finance | DOCUMENT_FIELD: `document.finance_agreement.lender_name` | Existing source; missing stays Unknown |
| doc_proposal | DOCUMENT_FIELD: `document.proposal.promised_monthly` | Existing source; missing stays Unknown |
| doc_statement | DOCUMENT_FIELD: `document.lender_statement.monthly_payment` | Existing source; missing stays Unknown |
| doc_payoff | DOCUMENT_FIELD: `document.payoff_letter.payoff_amount` | Existing source; missing stays Unknown |
| doc_utility_bill | DOCUMENT_FIELD: `document.utility_bill.utility_name` | Existing source; missing stays Unknown |
| doc_photo_id | DOCUMENT_FIELD: `document.government_id.full_name` | Existing source; missing stays Unknown |
| product_confirmed | DOCUMENT_FIELD: `document.product_type` | Existing source; missing stays Unknown |
| lender_confirmed | DOCUMENT_FIELD: `document.finance_agreement.lender_name` | Loan lender / explicitly qualified PPA counterparty |
| account_number | DOCUMENT_FIELD: `document.finance_agreement.account_number` | Loan account only; never utility account |
| contract_value | DOCUMENT_FIELD: `document.finance_agreement.amount_financed` | Existing source; missing stays Unknown |
| dealer_fee | DOCUMENT_FIELD: `document.finance_agreement.dealer_fee` | Actual disclosed fee, never internal 30% benchmark |
| apr_or_escalator | DOCUMENT_FIELD: `document.finance_agreement.apr` | Loan APR; PPA escalation uses product-aware resolver |
| term_months | DOCUMENT_FIELD: `document.finance_agreement.term_months` | Stated months or years ×12 |
| first_payment_or_install | DOCUMENT_FIELD: `document.finance_agreement.first_payment_date` | Loan first payment / actual PPA in-service only |
| current_payoff | DOCUMENT_FIELD: `document.payoff_letter.payoff_amount` | Actual payoff quote, not computed remaining balance |
| utility_company_and_bill | DOCUMENT_FIELD: `document.utility_bill.utility_name` | Existing source; missing stays Unknown |
| told_vs_signed | MANUAL: `null` | Manual/workflow input; no OCR inference |
| legal_hook_flags | MANUAL: `null` | Manual/workflow input; no OCR inference |
| path | MANUAL: `null` | Manual/workflow input; no OCR inference |
| fee_trench | MANUAL: `null` | Manual/workflow input; no OCR inference |
| closeability | MANUAL: `null` | Manual/workflow input; no OCR inference |
| docs_missing | MANUAL: `null` | Manual/workflow input; no OCR inference |
| dashboard_status | MANUAL: `null` | Manual/workflow input; no OCR inference |

## Interfaces, recovery, rollout

For large evidence, `data.analysis` carries metadata plus `artifact:{url,sha256,bytes}`. Only the configured SCS origin and `/api/internal/prodigyflo/analysis/{manifestId}?sha256=…` are allowed. Use `X-SCS-Export-Token`; redirects, excess bytes and hash/identity mismatch fail closed before a database transaction.

PF queues one `PropertyRecordsJob` per client + normalized full address fingerprint. Records API: POST `/api/service/property-records`, Bearer `RECORDS_ANALYZER_KEY`, `x-analysis-case`, idempotency key = persisted job ID. A parcel match and actual original outcome are required before importing originals. Authenticated `/api/service/originals/…` bytes are checked and privately stored with source/parcel provenance. Index-only, no-match, unsupported, failed and budget-paused remain explicit outcomes. Contact/address edits, including staff overview edits, supersede old jobs and expire their originals for current-property use while preserving bytes and review provenance. Returning to the same address reuses the original job/provider receipt and restores only untouched historical document statuses; intervening staff rejections remain. Late results cannot overwrite the current property, and parcel addresses are validated separately from the response envelope.

`DOCUMENT_ANALYZER=records` selects the staff analyzer; SCS-owned evidence is always imported once. `PROPERTY_RECORDS_PROVIDER=records` enables lookup execution. `RECORDS_JOB_BASE_URL` plus JOBS_TOKEN/CRON_SECRET enables immediate acknowledged continuation; scheduled runner recovers interrupted dispatches. Protected PF preview continuation accepts PF_VERCEL_PROTECTION_BYPASS. Native PDF/image packages remain server externals during Next builds. Preparation checkpoints three pages, upload checkpoints four images, model processing advances one durable stage at a time, including numeric verification. Cases spanning batches use case reconciliation. Three failed attempts pause; staff retry resets the same source job rather than creating a second SCS extraction.

Private service configuration: RECORDS_ANALYZER_URL/KEY; optional RECORDS_CF_ACCESS_CLIENT_ID/SECRET; SCS_DOCUMENT_EXPORT_BASE_URL/TOKEN; optional SCS_VERCEL_PROTECTION_BYPASS. No secrets are sent to redirects. Apply migrations to isolation first. Receiver → Worker → SCS is the rollout order. Source tests do not prove live Clark County coverage, original acquisition, booking callbacks, deployment or cost.
