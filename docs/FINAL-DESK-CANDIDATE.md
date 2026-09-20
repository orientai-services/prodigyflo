# Final HTML desk candidate — implementation checkpoint

Status: reviewable local candidate; **not approved for main or production**. The Records replacement and fresh real-document end-to-end test remain unfinished.

## Source and release boundary

The supplied `prodigyflo-full-FINAL-prototype (14).html` is preserved byte-for-byte at `docs/reference/final-prototype-14.html` (SHA-256 `bb81fdde6f38803355a989bd53f9e4548f72d1bb1bbc8c81bf670df29710371c`). Its visual structure, eight document modules, 17 profile cells, and 42 questions drive the candidate. The approved exceptions are two staff roles, truthful None choices for pressure/promises, real email-bound invitations, internal-only 30% benchmark, and real persistence/security. Quick look uses the existing authenticated PDF renderer within the prototype dialog.

`PRODIGYFLO_FINAL_DESK=true` activates the new screens and narrow route boundary. Without it, existing screens remain. No schema migration, table deletion, production configuration change, live deployment, or customer migration was performed for this increment. Disabling this switch restores the previous screens while retaining new questionnaire records. Older intake/CYS readers explicitly exclude the separately named questionnaire.

## Implemented

- Calendar, clients, profile, questionnaire, queue, deterministic Engine suggestions, document list, CYS readiness presentation, and Users use existing scoped records/actions.
- Super Admin sees the workspace; Closer queries remain assignment-scoped, including documents. Engine and Users are unavailable to Closers. Old frontend surfaces are denied while this flag is on.
- New questionnaire uses existing Survey/SurveyResponse tables under `ProdigyFlo Final Questionnaire`, version 14. Drafts persist section and revision; row locks plus revision checks reject conflicting edits. Staff attribution and deliberately cleared answers survive imports. Complete requires 42 valid answers.
- SCS equivalent answers and supported document facts prefill questions. Testimony about sales conduct, ownership, current performance, and consent is never inferred from contract text. Contract starting payments are qualified as historical, not current bills.
- Existing financial projection preserves PPA semantics, reviewed evidence, and missing values. The fixed 30% tile is labeled an internal benchmark, not an extracted fee. Credit bands are not promoted to numeric scores.
- Upload calls existing authorized, version-preserving storage. Quick look uses the authenticated original. `.eml` is accepted as plain-text content after byte validation.
- Mock invitation delivery refuses to claim an email was sent. Request-document controls remain draft-only; Call copies contact information. No external CYS submission is introduced.
- Final-desk cron mode skips unrelated automation, score refresh, digest, and telephony renewal; it retains the existing SCS document import/extraction path pending replacement.
- Generated lookup summaries are explicitly classified outside original deed/lien/permit modules. Original records still require actual source documents.

## Still unfinished / release blockers

1. **Records unattended API integration:** authenticated console reports its Claude Code runner on `DESKTOP-40C5FVD`. Service credentials and runner source/configuration are not available to this implementation. Browser login does not establish durable server authorization. No new production credential or Cloudflare Worker deployment was made.
2. **Provider replacement and reuse:** current SCS/PF extraction providers remain. Do not claim Records has replaced them, that cross-system duplicate extraction is eliminated, or that staff uploads have the new durable Records job lifecycle. These require the real service contract and runtime.
3. **Corrections synchronization:** Records reviewer identity, revisions, field evidence, and client/document correlation must be implemented and exercised after access is established. The existing Records console is not assignment-scoped for Closers.
4. **Record retrieval:** automated acquisition of original deeds, UCC filings, permits, and measured production reports is not proven. Existing county-search summaries are references only.
5. **Fresh contract test:** Edwin has not been re-submitted through the replacement pipeline. Local browser checks use the existing explicitly synthetic fixtures. Prior provider output is not new evidence for the replacement.
6. **Scheduling webhook:** separate Calendly account remains Free; signed booking-webhook proof stays blocked as previously agreed.
7. **Rollout:** protected deployment validation, production configuration checks, fresh backup/rehearsal, and explicit release approval are still required. Main is untouched.

## Verification for this increment

- Optimized PF webpack build and TypeScript checks passed. The pre-existing unpdf `import.meta` webpack warning remains nonfatal.
- 39 focused assertions cover questionnaire IDs, PPA mapping, None exclusivity, staff corrections, conflict detection, single response under concurrent writes, 42-answer completion, route boundaries, existing assignment/upload/access behavior, packet compatibility, and summary classification.
- Local browser: admin calendar/profile, questionnaire save/navigation/reload, rendered original PDF, Closer calendar with assigned appointments only, no Engine/Users for Closer, and 404 for another Closer's client.
- Private evidence: `implementation-private-01a0b8f2/final-desk/` outside the repository. Synthetic screenshots and logs are not production processing proof.

## Fixed profile destinations

| Destination | Source / boundary |
|---|---|
| Total / amount financed | Reviewed/quoted loan principal; not inferred for PPA/lease |
| Remaining balance | Existing explicitly labeled estimate; not payoff quote |
| Interest rate | Loan APR only |
| Interest paid to date | Existing estimate requiring supported inputs |
| Annual Escalator Rate % | PPA/lease escalation, never APR |
| Term years / months | Contract term; conversion explicitly derived |
| Years / months remaining | Requires supported actual start date and term |
| Monthly payment | Contract amount with period qualifier; first-year price is not current price |
| 30% Dealer Fee | Internal 30% benchmark, not documented dealer fee |
| Lender | Loan lender; PPA counterparty not inferred as lender |
| First payment date | Actual first-payment evidence, not signature/effective date |
| Agreement type | Product evidence / equivalent intake |
| Installer | Installer evidence, not assumed from counterparty |
| Credit score | Actual numeric intake score; not a credit pull or band |
| System size | Supported kW value |

## Questionnaire destinations

All fields accept explicit staff answers; equivalent SCS keys can prefill without changing wording or layout. Manual values take precedence. Document suggestions apply only to the narrow factual keys listed below; all other unsupported answers remain blank.

| Key | Existing question | Automatic source if available |
|---|---|---|
| `legal_name` | Full legal name | Client identity / same-key intake |
| `prop_addr` | Property address | Primary property address / same-key intake |
| `mail_same` | Mailing address same as property address? | Equivalent same-key intake only; otherwise staff |
| `phone` | Phone | Client contact / same-key intake |
| `email` | Email | Client contact / same-key intake |
| `sole_owner` | Are you the sole property owner? | Equivalent same-key intake only; otherwise staff |
| `on_contract` | Who is on the solar contract? (name/s) | Named customer/borrower evidence |
| `prop_type` | Property type | Equivalent same-key intake only; otherwise staff |
| `sales_co` | Solar company (sales company) | Explicit sales-company evidence |
| `install_co` | Installer company (if different) | Installer evidence / installer_guess |
| `lender` | Finance company or lender name | Loan lender evidence / lender_guess |
| `agree_type` | Type of solar agreement(s) | Equivalent product type |
| `year_signed` | Year contract was actually signed | Actual customer signature year only |
| `sign_where` | Where were the documents signed? | Equivalent same-key intake only; otherwise staff |
| `notice_3day` | Did you receive a 3-day cancellation notice? | Equivalent same-key intake only; otherwise staff |
| `got_copies` | Did you receive copies of all documents you signed? | Equivalent same-key intake only; otherwise staff |
| `first_contact` | How did the solar company first contact you? | Equivalent same-key intake only; otherwise staff |
| `pres_where` | Where did the main sales presentation take place? | Equivalent same-key intake only; otherwise staff |
| `pres_len` | Approximately how long did the sales presentation(s) last? | Equivalent same-key intake only; otherwise staff |
| `pressure` | Did the salesperson use high-pressure tactics? (check all that apply) | Equivalent same-key intake only; otherwise staff |
| `promises` | Promises made by salesperson (check all that apply) | Equivalent same-key intake only; otherwise staff |
| `misled` | Did you feel misled by the salesperson? | Equivalent same-key intake only; otherwise staff |
| `untrue` | Were there any other promises later discovered to be untrue? | Equivalent same-key intake only; otherwise staff |
| `mo_pay` | Monthly solar payment amount | Intake guess or explicitly qualified contract payment |
| `term_yrs` | Length of agreement / loan | Stated term; months-to-years conversion if supported |
| `escalator` | Does your payment increase yearly? | Explicit numeric annual escalation |
| `combo_bill` | Has your combined solar + utility bill increased? | Equivalent same-key intake only; otherwise staff |
| `told_lower` | Were you told your bill would be lower than it is now? | Equivalent same-key intake only; otherwise staff |
| `working` | Is your system working today? | Equivalent same-key intake only; otherwise staff |
| `perf` | System performance issues (check all that apply) | Equivalent same-key intake only; otherwise staff |
| `install` | Installation problems (check all that apply) | Equivalent same-key intake only; otherwise staff |
| `service` | Customer service issues experienced (check all that apply) | Equivalent same-key intake only; otherwise staff |
| `oob` | Has your installer or finance company gone out of business? | Equivalent same-key intake only; otherwise staff |
| `complaints` | Have you filed complaints anywhere? (check all that apply) | Equivalent same-key intake only; otherwise staff |
| `selling` | Are you selling or attempting to sell your home? | Equivalent same-key intake only; otherwise staff |
| `sale_issue` | Has the solar agreement caused issues with the sale? | Equivalent same-key intake only; otherwise staff |
| `ucc` | Was a UCC financing statement filed? | Equivalent same-key intake only; otherwise staff |
| `age` | Age range | Equivalent same-key intake only; otherwise staff |
| `le` | Limited English? | Equivalent same-key intake only; otherwise staff |
| `credit_ck` | Was a credit check run? | Equivalent same-key intake only; otherwise staff |
| `hardship` | Has the solar panel contract caused financial hardship? | Equivalent same-key intake only; otherwise staff |
| `goal` | What outcome are you seeking? | Equivalent same-key intake only; otherwise staff |
