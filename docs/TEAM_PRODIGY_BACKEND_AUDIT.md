# Team Prodigy backend operating-system audit

**Status:** Phase 1 baseline — no product behavior changed  
**Audience:** Team Prodigy operations  
**Scope:** SCS inbound lead handling, task management, pipeline movement, documents, and close handoff  
**Decision rule:** Preserve proven ingestion, security, document, and audit controls. Consolidate staff work around one Client record and one daily Work Queue. Do not delete a route, model, or writer before its callers, monitors, and replacement path are proven.

## 1. What production proves today

This is an operating-data snapshot, not page-view telemetry. The application does **not** currently record which screens people open, so zero records prove a capability has not processed work; they do not prove nobody has viewed its page.

| Signal | Team Prodigy production evidence | Meaning |
|---|---:|---|
| Active staff | 2 Super Admins, both direct members of `SCS Inbound` | Shared team visibility exists. |
| Intake | 3 `APPLIED` SCS submissions and 3 `InboundEvent` rows | Secure capture and client creation are live. |
| Routing | 3/3 created clients in `SCS Inbound`; 0 routing violations | The shared-queue routing policy is working. |
| Pipeline | 3 `NEW_LEAD` clients and 3 stage-history rows | Leads enter the CRM but have not progressed. |
| AI | 3 close-probability scores | Scoring is running, but it does not create work. |
| Documents | 2 imported documents; import audit rows present | The SCS document path is operating. |
| Work | 0 tasks, 0 communications, 0 appointments, 0 assignments | There is no active lead-management loop. |
| Nurture / close | 0 sequences, enrollments, scheduled messages, nurture touches, deals, qualification reviews, or submissions | The downstream workflow is not configured or proven in production. |

## 2. The canonical data path

```text
SCS authenticated packet
        |
        v
IntakeSource + IntakeSubmission + InboundEvent
        |
        +--> ExternalDocumentImport --> ClientDocument --> DocumentExtraction
        |
        v
Client + StageHistory + AuditEvent             [one system of record]
        |
        +--> Task / Assignment                  [what a human must do]
        +--> Communication / Inbox               [what the lead said]
        +--> Appointment / Qualification         [sales handoff]
        +--> Deal / Submission                    [downstream outcome]
```

`Client` is the canonical record. Every queue must be a filtered view of this path; it must not become a second, independently-maintained workflow.

## 3. Lead-facing interface map

| Operating view | Current route(s) | Canonical query / records | Staff action | Audit decision |
|---|---|---|---|---|
| **Inbound operations** | `/inbound`, `/inbound/[eventId]` | `InboundEvent`, `InboundDocument`, `IntakeSubmission` | Diagnose bad payloads, unmatched events, duplicate/retry conditions, and document import failures. | **Keep — operations-only.** Never use as a lead calling queue. |
| **Daily Work Queue** | Missing | `Client` + open `Task` + stage SLA + inbound reply + ownership + document/submission blockers | Claim, call, reply, schedule, escalate, or resolve the next action. | **Create — primary Team Prodigy landing view.** |
| **Lead directory** | `/clients` | Scoped `Client` records with owner, team, source, stage, value, activity | Search, filter, bulk reassign, correct data, open a record. | **Keep.** This is a directory, not a task queue. |
| **Pipeline board** | `/board` | Active `Client` records grouped by `PipelineStage` | Controlled stage movement and manager review. | **Keep, but reduce frontline stages.** |
| **Client command record** | `/clients/[clientId]` | Client, stage history, tasks, notes, communications, documents, readiness, assignments, AI context | The only place to edit a lead's facts and resolve its individual work. | **Keep as the command center.** |
| **Inbox** | `/inbox`, client Communications tab | Inbound and outbound `Communication` / `Message` records | Reply, handle opt-out, resolve unmatched communication. | **Keep.** An inbound reply must create/elevate a work item. |
| **Document review** | `/documents`, `/documents/[documentId]`, client Documents tab | `ClientDocument`, `DocumentExtraction`, `DocumentReview` | Verify, correct, request, approve, reject, or route document work. | **Keep — specialist queue.** |
| **Qualification / closing queue** | `/sales/hot-leads`, `/sales/qualifier`, `/sales/nurture` | `Client`, close score, `HotLeadReview`, `NurtureTouch`, appointment | Prioritize, human-qualify, assign a closer, complete pre-call work. | **Merge into Work Queue modes.** Do not maintain three independent work surfaces. |
| **Submission / specialist handoff** | `/attorney`, `/submissions`, client CYS tab | `CysReadiness`, `Deal`, `Submission`, documents | Prepare, approve, manually deliver, record outcome. | **Preserve but remove from frontline navigation until SCS confirms this path.** |
| **Management health** | `/dashboard`, `/sales`, `/attention`, `/sales/huddle`, `/sales/hygiene`, `/reports`, `/performance` | Aggregated Client/Task/Communication/Deal data | Identify exceptions and drill into a work queue. | **Consolidate.** Reporting must link to work, never substitute for it. |

## 4. Interface de-noise decision matrix

### A. Daily Team Prodigy navigation

| Destination | Decision | Why |
|---|---|---|
| Work Queue (new) | Add | Missing control plane for new, overdue, replied, unclaimed, and blocked leads. |
| Clients | Keep | Searchable record directory and bulk operations. |
| Pipeline board | Keep | Stage/aging management; useful for manager review. |
| Inbox | Keep | Reply and opt-out response work. |
| Documents | Keep | Imported documents already operate in production. |
| Inbound | Keep, operations permission only | Raw payload/audit diagnosis belongs to admins, not closers. |
| Client record | Keep | Single record-level command center. |

### B. Consolidate behind Work Queue modes or manager review

| Current surface | Target | Reason |
|---|---|---|
| `/sales/hot-leads` | `Work Queue: Priority` | A score is one prioritization attribute, not a separate workflow. |
| `/sales/qualifier` | `Work Queue: Qualification` | Human sign-off should create the next action/assignment. |
| `/sales/nurture` | `Work Queue: Pre-call` | A touch is a task state, not an app section. |
| `/sales/huddle` | Manager daily summary | Summary only; rows must drill into Work Queue. |
| `/attention` + `/sales/hygiene` | Manager exception feed | Both describe operational drift. One underlying exception model is sufficient. |
| `/dashboard` + `/sales` | Manager overview | Keep one overview per role; avoid duplicate scorecards. |
| `/reports/*` + `/performance` | Analytics / manager area | Retain outcomes and reporting but remove from daily work navigation. |

### C. Preserve, but park from the SCS inbound operating flow

| Area | Routes / modules | Status |
|---|---|---|
| Marketing and Meta | `/marketing/*`, `src/lib/meta`, `marketing-metrics` | Preserve configuration and attribution; no current Team Prodigy data proves daily use. |
| Telephony | `/settings/phone-numbers`, `src/lib/telephony` | Preserve; do not make it a prerequisite for the first-touch task loop. |
| Agency operations | `/agency`, org switching | Outside Team Prodigy staff operation. |
| Prodigy Engine | `/engine`, `src/lib/engine` | Preserve as experimental/system layer; it must not silently become lead routing. |
| Coaching, calibration, gamification | `/sales/coaching`, `/sales/accuracy`, `coaching`, `calibration`, `scoreboard` | Manager capability, not an inbound-lead prerequisite. |
| Attorney/CYS workflow | `/attorney`, `/submissions`, `cys`, `attorney`, `packet` | Preserve data safety and manual handoff. Activate only when SCS confirms it is the close destination. |
| Recovery and portal | `/recovery/*`, `/portal` | Separate customer/recovery programs, not the initial Team Prodigy staff loop. |

## 5. Backend module disposition

| Module boundary | Principal code | Disposition | Required change in the target system |
|---|---|---|---|
| Identity / tenant scope | `src/lib/auth.ts`, `rbac.ts`, `permissions.ts` | Keep | Super Admin/Admin access to all Team Prodigy leads remains server-enforced through `clientScope`. |
| SCS intake | `src/app/api/intake/[slug]/route.ts`, `src/lib/intake/*` | Keep | Add explicit post-intake orchestration only after successful idempotent client creation. |
| Pipeline state | `pipeline.ts`, `stage-transitions.ts`, board actions | Keep and simplify | Retain atomic stage history/audit; reduce frontline state vocabulary and move detail into task/checklist gates. |
| Work management | `Task`, task forms, `reporting.ts` | Expand | Create a scoped global work-query service and a single task/SLA writer contract. |
| Communications | `messaging/*`, `/inbox`, automation engine | Keep and wire | Inbound reply must update work state; outbound automation requires an explicit Team Prodigy sender. |
| Nurture automation | `automation/*`, `Sequence*`, `ScheduledMessage` | Repair before enabling | Intake does not invoke stage-trigger enrollment; ownerless leads have no sender fallback. |
| Assignment | `assignment.ts`, client assignment actions | Keep and adapt | Distinguish shared-team queue membership from a named closer owning the next action. |
| Documents | `storage/*`, `extraction/*`, `scs-document-import.ts` | Keep | Maintain private files, checksum, retry ledger, extraction, and review. |
| Closing / submission | `qualifier.ts`, `closeops.ts`, `Deal`, `Submission`, `cys/*`, `packet/*` | Preserve / defer | Do not make scoring, qualification, or submissions automatic; every handoff must be human-recorded. |
| Observability | `AuditEvent`, `timeline.ts`, `attention.ts`, `reporting.ts`, jobs | Keep and consolidate | A Work Queue item must always link to the evidence that made it actionable. |

## 6. State-writer map

This is the control map for future cleanup. The target is not to remove every writer; it is to make each state change have one canonical service and to prevent parallel writers from silently bypassing lead-management obligations.

| State | Current writers / entry points | Target control |
|---|---|---|
| Client creation | SCS intake `processInbound`, manual client creation, CSV import, GHL import, Meta lead ingestion, Instagram path | All production lead sources must converge on the idempotent intake/apply service or an equally strict adapter. Post-create orchestration happens once, only when a client was actually created. |
| Stage transition | Board, client record, recovery flow, CYS actions, reporting bulk action → `moveClientToStage` | Keep `moveClientToStage` as the sole writer for stage/history/status. Do not add direct `currentStageId` writers except initial client creation. |
| Tasks | Client task forms, AI-assist acceptance, message-send optional follow-up | Introduce one `ensureLeadObligation` service for first touch, reply, SLA escalation, and handoff tasks. Manual task creation remains allowed. |
| Communications | Manual message API/actions, automation engine, inbound SMS/email, portal reply, call logging, telephony | Continue using `sendMessage` for all outbound sends. Inbound handling must also update the Work Queue. |
| Assignment | Client assignment panel → `assignClientToCloser` | Keep named closer assignment separate from Team membership. A team queue is visibility; an assignment is accountability. |
| Qualification | Qualifier action → `HotLeadReview` | Keep human decision. Wire approved/rejected decisions to the next task rather than treating review rows as the endpoint. |
| Documents | Upload route/actions, external SCS importer, extraction runner, review actions | Preserve independent durable import/extraction/review lifecycle; document state is a Work Queue blocker, not a separate client identity. |
| Submission | CYS/attorney draft, submission status actions | Retain manual human-approved handoff. Do not auto-submit while the actual SCS destination contract is unconfirmed. |

### API surface disposition

| API family | Routes | Decision |
|---|---|---|
| Identity and account | Auth, signout, profile avatar | Keep. |
| Lead ingress | `/api/intake/[slug]`, intake sync, inbound channel, Meta lead/Instagram hooks | Keep SCS path; place inactive source adapters behind configuration rather than deleting. |
| Lead work | Client export, messages, search, notifications, templates | Keep. These support the command record and Work Queue. |
| Documents and package | Document file/upload, CYS package, submission package | Keep access controls and private storage. Park specialist package delivery from frontline navigation. |
| Scheduled execution | `/api/jobs/run` | Keep. It is the execution boundary for imports, automations, score refresh, digests, engine work, and telephony renewal. Split its result reporting by subsystem before adding more jobs. |
| Telephony | SMS and voice routes | Preserve/configure separately; no first-touch workflow may depend on an unproven provider. |
| Deploy administration | `/api/admin/deploy/*` | Preserve as owner-only operational infrastructure, outside lead operations. |

## 7. The minimal frontline state model

The existing default pipeline contains 25 stages. It is a complete enterprise lifecycle, but it is too granular for Team Prodigy's first-touch operation.

The proposed frontline view is a grouping layer, not an immediate destructive schema rewrite:

```text
NEW              Lead arrived; first-touch obligation exists.
WORKING          Contact, verify, or collect missing information.
QUALIFY          Human review / fit decision is due.
CLOSE            Named closer, appointment, proposal, or follow-up is active.
FULFILL           Documents or external package blocks completion.
WON / LOST / HOLD Terminal outcome with reason and recovery date where applicable.
```

Existing detailed stages can remain as back-office transition rules initially. The board and Work Queue should display these six operational groups first, preventing a data migration from becoming a precondition for starting work.

## 8. Work Queue contract

The queue is a derived read model. It must not create a second lead table.

### Required row fields

- Client identity, Team, named owner/closer (if any), source, and operational group
- One explicit `nextAction` with due time, severity, and reason
- Latest client activity and latest inbound reply
- Stage age and SLA state
- Document/submission block state where applicable
- Evidence links: task, communication, stage history, import/audit event

### Required queue modes

1. **New / unclaimed** — no named owner and first-touch deadline not resolved.
2. **Due now / overdue** — open task, stage SLA, or follow-up deadline has expired.
3. **Replies waiting** — inbound communication has no later outbound response or resolved task.
4. **Qualification** — human decision is required after enough evidence exists.
5. **Closer follow-up** — assigned closer has appointment, follow-up, or next step due.
6. **Document blocked** — required document or review blocks progress.
7. **Close / recovery** — submission/outcome work or a timed lost/hold recovery action.

### Writer rules

- A successful new SCS client must create one first-touch obligation in the same operational flow as routing and audit.
- A duplicate replay must create neither a second task nor a second enrollment.
- A client reply must create or elevate a response obligation.
- Closing a task must require a next action, terminal outcome, or documented reason that no action is needed.
- A lead may be visible to `SCS Inbound` while unclaimed, but cannot remain unclaimed beyond its configured SLA.
- Every automated action needs a named system/Team Prodigy sender identity and a stop/escalation behavior.

## 9. Required proof before any cleanup

| Injection | Required proof |
|---|---|
| Valid SCS packet | One client, one queue row, one first-touch obligation, auditable provenance. |
| Duplicate packet | No duplicate client, task, sequence enrollment, or outbound message. |
| Bad auth / invalid payload | No client or cross-tenant data exposure. |
| Unclaimed lead expires SLA | Escalation is visible to Team Prodigy. |
| Client reply / opt-out | Reply is prioritized; opt-out stops outbound work. |
| Missing contact method | Lead enters an exception path, not an impossible-to-send sequence. |
| Document checksum or extraction failure | Ledger remains retryable and blocks the appropriate downstream state. |
| Qualification / closer assignment | Human decision and named owner create the next task. |
| Loss / hold | Reason is recorded and recovery action is scheduled only when appropriate. |
| Permissions | Every Team Prodigy admin can see the shared queue; out-of-scope users cannot. |

## 10. Execution order

1. **Current phase:** finish the writer/API/model call graph and confirm the keep/merge/park matrix against every route and server action.
2. **Target contract:** agree the Team Prodigy operational groups, first-touch SLA, escalation owner, and sender identity.
3. **Foundation build:** implement the Work Queue query/service and intake-to-first-task orchestration; add regression and injection tests.
4. **Navigation de-noise:** hide/relocate duplicate daily-work screens only after their Work Queue equivalent passes production QA.
5. **Pipeline simplification:** project existing detail stages into operational groups first; change stored stage configuration only after the team has run the new loop with real leads.
6. **Close-path activation:** decide whether CYS/attorney/submission is truly part of SCS's close process, then activate only the needed specialist routes.

## 11. Explicit non-actions

- No production records, roles, stage configurations, or navigation have been changed during this audit.
- No models or modules are candidates for deletion yet; a parked capability must keep its readers and monitors valid until deliberately retired.
- No claim is made that a route is never opened; page-view telemetry does not exist.
- `MVP_STATUS.md` contains historical deployment assertions that conflict with the current Vercel/SCS implementation. Treat this audit, source code, and live database evidence as authoritative until the status document is reconciled.
