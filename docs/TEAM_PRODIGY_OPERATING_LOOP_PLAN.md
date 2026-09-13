# Team Prodigy operating loop — implementation plan

**Status:** Proposed; no application behavior changed  
**Build:** Shared-team Work Queue and intake-to-outcome lifecycle  
**Source audit:** [`TEAM_PRODIGY_BACKEND_AUDIT.md`](./TEAM_PRODIGY_BACKEND_AUDIT.md)  
**Definition of done:** Every new SCS lead is either visibly owned or in the shared Team Prodigy queue, has one actionable next step with an SLA, and can move through human communication, qualification, closing, and outcome without becoming a stranded CRM row.

## 1. Boundaries and operating posture

### What this build includes

1. Durable first-touch tasks created for successful new SCS clients.
2. One Team Prodigy Work Queue derived from `Client`, `Task`, communication, assignment, and blocker data.
3. Team queue claiming and explicit case ownership for Admin/Super Admin staff.
4. Human-first nurture and communication work, including reply prioritization and consent-safe email drafting/sending.
5. Human qualification, close follow-up, and terminal outcome obligations.
6. SLA escalation, audit traces, regression tests, and production-grade injection proof.

### What this build explicitly does not include

- Automatic SMS: production SMS is mock and there are no active phone numbers.
- Automatic email sequences: Resend is configured, but production has no recorded consent and no Team Prodigy automation sender identity.
- AI-directed qualification, assignment, or closing: the production AI provider is mock; any score remains an optional prioritization signal.
- Direct CYS/attorney submission: preserve the existing manual specialist workflow until SCS confirms it is its real close destination.
- Deleting existing routes, models, or pipeline detail during the first release.

## 2. Stack-Spine ownership map

| Layer | Scope | Ownership | Planning consequence |
|---|---|---|---|
| L12 Human / org | Team Prodigy shared queue, case-owner expectations, first-touch SLA, qualification rules | ● | The team policy is the source of the system's behavior. |
| L11 Cloud / edge | Vercel production, Resend, S3-compatible document storage, SCS export host | ◐ | Provider failures must create observable task/import states, not silent drops. |
| L10 Network | HTTPS webhook and private SCS document-export traffic | ◐ | Existing authenticated intake/export contracts remain unchanged. |
| L9 Identity / secrets | Auth.js, role permissions, intake tokens, cron authorization, provider credentials | ● / ◐ | Work Queue queries and actions must use `clientScope`; no secrets move into UI code. |
| L8 Application | Intake, tasks, assignments, messaging, stage changes, jobs, audit | ● | This is the primary build surface. |
| L7 Runtime | Next.js, Prisma, PostgreSQL | ◐ | Use Prisma transactions and database uniqueness for idempotency. |
| L6 Staff interface | Work Queue, Client record, board, inbox | ● | Screens render a derived read model; they never become workflow sources of truth. |
| L0–L5 | Physical through host/container layer | ○ | No change in this build. |

## 3. Target lifecycle

```text
SCS intake
  │  authenticated + idempotent
  v
NEW / shared Team Prodigy queue
  │  create FIRST_TOUCH task, no automatic message
  ├── claim by Admin/Super Admin ────────────────┐
  │                                               v
  │                                          WORKING
  │                                      call / email / gather facts
  │                                               │
  └── SLA breach → team escalation                v
                                          QUALIFICATION
                                  human decision + reason/evidence
                                      │                 │
                                      v                 v
                                  CLOSE             LOST / HOLD
                         appointment / follow-up      reason + recovery task
                                      │
                                      v
                         FULFILL / specialist handoff
                                      │
                                      v
                                  WON / LOST
```

The existing detailed `PipelineStage` rows stay intact at first. The Work Queue and Board project them into these operational groups:

| Operational group | Initial detailed stages |
|---|---|
| New | `NEW_LEAD`, `SURVEY_STARTED`, `SURVEY_COMPLETED`, `INFO_VERIFICATION` |
| Working | `CONSENT_PENDING`, credit and verification stages |
| Qualification | `QUALIFICATION_REVIEW`, `QUALIFIED`, `NOT_QUALIFIED` |
| Close | appointment, presentation, payment, and follow-up stages |
| Fulfill | document, attorney, submission, correction, and approval stages |
| Terminal | `CLOSED_WON`, `CLOSED_LOST`, `ON_HOLD` |

## 4. Canonical responsibility model

### Shared queue vs. case owner vs. closer

| Concept | Current model | Target meaning |
|---|---|---|
| Team visibility | `Client.teamId` → `SCS Inbound` | Every inbound SCS lead is visible to all Team Prodigy staff. |
| Case owner | `Client.ownerId` | The Admin/Super Admin who has claimed the next action. This is the frontline accountability field. |
| Closer assignment | `Assignment` with role `CLOSER` | Reserved for a future dedicated closer role; do not require it for Team Prodigy to work leads today. |
| Task assignee | `Task.assigneeId` | Normally mirrors the case owner for actionable work. Unassigned first-touch tasks remain visible to the team queue. |

### Claim policy

1. A new SCS client enters `SCS Inbound` with `ownerId = null`.
2. Any active Team Prodigy Admin/Super Admin with client-update authority may atomically claim an unowned lead.
3. Claiming sets `Client.ownerId`, assigns the currently open obligation to that user, updates activity, and writes one audit event.
4. A claimed lead may be explicitly reassigned by an authorized admin; no silent overwrite.
5. A dedicated closer assignment is optional and comes only after the team has a real closer roster and qualification policy.

## 5. Task and Work Queue data contract

### Reuse `Task`; do not create a second queue table

Extend the existing `Task` model rather than adding a competing `LeadQueueItem` table.

| Field | Change | Reason |
|---|---|---|
| `kind` | Add `TaskKind` enum: `FIRST_TOUCH`, `REPLY`, `QUALIFICATION`, `FOLLOW_UP`, `DOCUMENT`, `CLOSE`, `RECOVERY`, `MANUAL` | Queue modes and metrics must not parse free-text task titles. |
| `workflowKey` | Add nullable string | Stable idempotency key for system-created obligations, e.g. `first-touch`, `reply:<communicationId>`, `qualification:<stageHistoryId>`. |
| `source` / `origin` | Add `TaskOrigin`: `MANUAL`, `INTAKE`, `COMMUNICATION`, `STAGE`, `SYSTEM` | Human and system work remain distinguishable. |
| compound uniqueness | Add unique `(clientId, workflowKey)` | A delivery replay cannot create duplicate first-touch or reply tasks. PostgreSQL permits multiple null keys, so manual tasks remain unrestricted. |
| lookup index | Add `(status, dueAt)` and `(kind, status, dueAt)` indexes | Work Queue remains bounded and cheap as volume grows. |

The existing task fields stay authoritative: `clientId`, `assigneeId`, `createdById`, title, description, priority, `status`, `dueAt`, `completedAt`, and optional `stageKey`.

### New service boundary

Create `src/lib/lead-work/` with two server-only modules:

| Module | Responsibilities |
|---|---|
| `obligations.ts` | Transaction-safe `ensureLeadObligation`, `claimLead`, `reassignLead`, `resolveLeadObligation`, and `escalateOverdueLeadWork`. |
| `queries.ts` | One scoped `getWorkQueue(user, filters)` query, queue-row derivation, operational-stage grouping, and counts. |

Existing Client, task, message, stage, and assignment actions call these services. The Work Queue page is read-only against the derived query plus deliberate action endpoints; it does not write database state directly.

## 6. Intake-to-first-task orchestration

### Trigger

Only a newly-created Client from an enabled SCS `IntakeSource` triggers the initial obligation. Matched duplicates, ordinary payload replays, and SCS refresh packets do not.

### Atomic write set

Refactor the new-client portion of `src/lib/intake/apply.ts` into one Prisma transaction:

1. Create `Client` in the tenant-safe configured team.
2. Create initial `StageHistory`.
3. Create optional address and source note.
4. Upsert `FIRST_TOUCH` task with `workflowKey = 'first-touch'`, unassigned, high priority, and the configured due time.
5. Write the `intake.client_created` and `lead_obligation.created` audit rows.

If any of those writes fail, the `IntakeSubmission` records the actionable failure and remains retryable; it must not leave a client without the first task.

### Default task content

```text
Title: Contact new SCS lead
Reason: First contact is due; claim this lead or explicitly reassign it.
Evidence: intake source, received time, client contact availability, documents received.
Next action: Call or send a consent-safe email; log the result and set the next follow-up.
```

No automated email or SMS is sent by this trigger.

## 7. Communications and nurture plan

### Phase 1 — human-first

| Event | Result |
|---|---|
| First-touch task is claimed | Staff calls or sends an allowed email from the Client record; the action is persisted as `Communication`. |
| No electronic-communication consent | Composer states why email cannot send; task requires consent/contact capture or a different permitted human action. |
| Inbound reply | `recordInbound` / channel receiver upserts a `REPLY` task keyed by communication ID, raises priority, and surfaces it in `Replies waiting`. |
| Outbound reply after inbound | Completing the reply task requires an outbound communication or an explicit documented resolution. |
| Opt-out | Consent logic remains the hard stop; Work Queue becomes an exception/relationship task, never an auto-send queue. |
| Follow-up chosen by staff | Create a `FOLLOW_UP` task with due time; no hidden scheduled send. |

### Phase 2 — only after provider readiness is proven

Automatic email nurture may be enabled only when all of the following are true:

1. A Team Prodigy sender identity is defined and authorized by the send service.
2. Resend sender/domain and inbound-event path are production-proven.
3. Consent is recorded for the recipient channel.
4. Templates are approved and a stop/escalation policy exists.
5. Integration tests demonstrate sequence enrollment, reply stop, failed-send retry, and opt-out stop.

SMS remains disabled until a real provider, number, consent path, and inbound webhook are verified.

## 8. Qualification and close loop

### Qualification

- Use the pre-existing `QualificationReview` as the canonical business decision record.
- Treat `HotLeadReview` as legacy AI-prioritization history during transition; do not make it the required business gate.
- A `QUALIFICATION` task is created when the owner moves a record into the qualification operational group or explicitly requests review.
- Human approval completes the qualification task and creates either a `CLOSE` task or a documented hold/loss path.
- The AI score may appear as context only; it cannot approve, reject, assign, or close a lead.

### Close

- The case owner owns the `CLOSE` obligation until a real dedicated closer is assigned.
- Appointment, proposal, and follow-up remain Client-record actions with explicit tasks and due times.
- `CLOSED_LOST` requires a reason and creates a `RECOVERY` task only when the chosen loss reason supports a later revisit.
- `CLOSED_WON` completes open sales obligations and retains document/submission steps only if SCS confirms that specialized handoff is part of the sale.
- `Deal` and `Submission` remain downstream records, not prerequisites for first-touch or qualification work.

## 9. New and changed interface surfaces

| Surface | Change |
|---|---|
| `/work` (new) | Default Team Prodigy landing page with New/unclaimed, due, replies, qualification, close, document-blocked, and recovery modes. |
| `/clients/[clientId]` | Add Claim / Reassign controls, next-action panel, and task completion rules. Preserve existing detail tabs. |
| `/inbox` | Each inbound reply links to its Work Queue obligation and reflects resolution state. |
| `/board` | Display operational group and a next-action indicator; retain controlled detailed stage changes. |
| `/clients` | Retain directory/bulk role; link rows to Work Queue state rather than duplicate task columns. |
| `/sales/*` | No initial deletion. Gradually redirect daily queues to `/work` filters once parity tests pass. |

## 10. Files expected to change

| Area | Planned files |
|---|---|
| Schema / migration | `prisma/schema.prisma`, a new Prisma migration |
| Lead work services | new `src/lib/lead-work/obligations.ts`, `queries.ts`, tests |
| Intake | `src/lib/intake/apply.ts`, importer/intake tests as necessary |
| Jobs | `src/app/api/jobs/run/route.ts` plus focused escalation worker |
| Communications | `src/lib/messaging/inbound.ts`, channel route(s), message tests |
| Client actions | `src/app/(app)/clients/[clientId]/actions.ts`, task/claim UI components |
| Work Queue UI | new `src/app/(app)/work/page.tsx`, queue controls/actions/components |
| Navigation | `src/lib/navigation.ts`, role home defaults only after queue passes QA |
| Existing tests | intake, task actions, RBAC, automation, jobs, Playwright routes |

## 11. Acceptance and injection matrix

| Claim | Injection / proof |
|---|---|
| New SCS lead has exactly one first-touch obligation | Deliver valid packet, retry identical packet, assert one Client + one `FIRST_TOUCH` task + two expected audit records only. |
| The task is tenant-safe | Attempt cross-tenant claim/read/reassign; assert forbidden/no result. |
| Shared queue has a real claim race guard | Two concurrent claims: one succeeds, one receives an already-claimed response; no owner overwrite. |
| No lead silently expires | Advance clock/job execution beyond SLA; assert escalation notification/task and audit row. |
| Reply work is durable | Record inbound reply twice; assert one `REPLY` task keyed to its communication, then send/log response and resolve it. |
| Consent blocks automation | No consent, revoked consent, expired consent, and STOP input each refuse email/SMS delivery and leave an actionable exception. |
| Human qualification is authoritative | Mock AI score conflicts with reviewer decision; assert only human decision controls next task/stage. |
| Loss is not a dead end | Close lost with recoverable reason creates one timed recovery task; non-recoverable reason does not. |
| Existing SCS document path survives | Run importer unit suite and a production QA packet; checksum/import/extraction behavior is unchanged. |
| UI is only a projection | Work Queue counts match direct scoped database queries across all modes. |

## 12. Rollout order

1. Add task typing/idempotency migration and lead-work service with unit tests.
2. Refactor SCS intake creation into transaction-backed first-touch orchestration.
3. Add claim/reassign and first Work Queue mode: **New / unclaimed**.
4. Add due/overdue escalation job and **Due now** mode.
5. Add reply obligations and **Replies waiting** mode.
6. Add human qualification, close, and recovery obligations.
7. Add document-blocked mode and board/client next-action indicators.
8. Run all injections locally, deploy privately, inject a synthetic SCS packet in production, and verify the complete audit trail.
9. Only then change Team Prodigy's default landing route and de-noise duplicate Sales navigation.

## 13. Decisions required before implementation

1. First-touch SLA and after-hours clock.
2. Escalation recipient when a lead remains unclaimed.
3. The human qualification checklist for SCS (the exact facts that make a lead ready for closing work).
4. The meaningful close outcomes for SCS and which lost reasons should create recovery work.
5. Whether Resend email should remain manual-only until a dedicated Team Prodigy sender/process is ready.

**Recommended starting policy:** 15 minutes during business hours; 9:00 AM next business day for after-hours submissions; escalate to all active Team Prodigy Admin/Super Admin staff; keep email manual and consent-gated; keep SMS and AI automation disabled.
