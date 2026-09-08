# ASSUMPTIONS

Decisions made without an explicit answer from the product owner. Each one is
reversible; where a choice constrains the data model the reversal cost is noted.

Last reviewed: 2026-08-24

---

## A1 — This project is the Sales Client Overview application

`prodigyflo` (Next.js 16 + Prisma 7 + PostgreSQL + Auth.js v5) already carries a
1,389-line domain schema headed `ProdigyFlo — Sales Client Overview`, a seeded
synthetic dataset, RBAC, audit logging and an AI provider abstraction. It is
treated as the existing architecture the steering prompt says to preserve rather
than something to rebuild.

**Reversal cost:** total. Everything below assumes this codebase.

## A2 — "Lead" and "client" are the same record

The schema has `Client`, not `Lead`. Rather than add a parallel `Lead` table and
a conversion step the MVP does not need, a lead *is* a `Client` whose current
pipeline stage sits in the `INTAKE` category. The UI says "lead" where the record
is pre-qualification and "client" afterwards.

**Reversal cost:** high — a separate Lead table would fork every downstream join.

## A3 — Statuses are pipeline stages, and are configurable in the database

The steering prompt lists ten initial statuses. `PipelineStage` rows already
provide configurable, per-organization statuses with SLA, checklist and allowed
transitions, so the requested statuses are mapped onto existing `StageKey`
values instead of being added as a second status field:

| Requested status    | StageKey                     |
| ------------------- | ---------------------------- |
| New                 | `NEW_LEAD`                   |
| Follow-up needed    | `FOLLOW_UP`                  |
| Documents requested | `DOCUMENT_COLLECTION`        |
| Documents received  | `DOCUMENT_COLLECTION`¹       |
| Document review     | `ATTORNEY_DOCUMENT_REVIEW`   |
| Missing information | `INFO_VERIFICATION`          |
| CYS ready           | `DEAL_READY_FOR_SUBMISSION`  |
| Submitted to CYS    | `SUBMITTED`                  |
| Completed           | `CLOSED_WON`                 |
| Disqualified        | `NOT_QUALIFIED`              |

¹ "Requested" vs "received" is tracked per document on `ClientDocument.status`,
which is finer-grained than a single client-level stage. The client-level stage
advances when the document package is complete.

`Client.status` (`ACTIVE / ON_HOLD / DISQUALIFIED / CLOSED_WON / CLOSED_LOST`)
remains a coarse lifecycle flag, not the workflow status.

## A4 — Document statuses extend the existing enum rather than replace it

The requested list needed two values the schema lacked. `DocumentStatus` now
reads `REQUESTED → RECEIVED → PROCESSING → UNDER_REVIEW → MISSING_INFORMATION →
APPROVED / REJECTED / EXPIRED`, where `RECEIVED` is the requested "Uploaded" and
`UNDER_REVIEW` is the requested "Review required".

## A5 — CYS is the Vercel portal, and it has no API

**CYS means the "Cancel Your Solar" portal at
`https://cancel-your-solar-iota.vercel.app/portal/dashboard`** — a separate
Next.js + Supabase application on Vercel. It is *not* `cancelyoursolar.app`
(the Flask/SunOff droplet), and the two must not be conflated when wiring the
handover.

No API documentation or credentials for that portal are available, and none is
invented. Phase 5 ships a **configurable field map** (`CysFieldDefinition`), a
**readiness workspace** (`CysReadiness`, `CysFieldValue`) and a **generated JSON
package**. Delivery is a manual export until the portal's intake contract is
known. Direct submission is P1 and explicitly gated on that.

Because the map is data rather than code, matching the portal's real intake
fields is an edit in Settings → CYS field map, not a deploy. The starter set is
a documented guess at a solar-cancellation handover and should be reconciled
against the portal's actual dashboard fields before first real use.

## A6 — Every external provider ships as a mock adapter first

No credentials exist for email, SMS, file storage, Google Sheets or the credit
bureau. Each is implemented behind an interface with a mock adapter selected by
env var (`EMAIL_PROVIDER`, `SMS_PROVIDER`, `FILE_STORAGE_DRIVER`,
`SHEETS_PROVIDER`), following the pattern `src/lib/ai/` already uses
(`AI_PROVIDER=mock|anthropic`). Mock mode is labelled in the UI — it never
pretends a message was really delivered.

## A7 — Document storage is local-disk in development

`FILE_STORAGE_DRIVER=local` writes to `storage/documents/` (git-ignored) under a
random opaque key; the filename the client uploaded is metadata only, never a
path. Access is always through a short-lived signed URL issued by the server
after a permission check — the directory is never statically served. An S3-
compatible driver slots in behind the same interface.

## A8 — Duplicate detection matches on normalised email, then phone

Order is configurable per intake source (`IntakeSource.dedupeKeys`, default
`["email", "phone"]`). Email is lower-cased and trimmed; phone is reduced to its
last 10 digits. A match **updates** the existing lead and records the touch — it
never silently creates a second record, and never overwrites a non-empty CRM
field with an empty incoming one. Matches are scoped to the organization.

Near-matches (same name + same postal code, different contact details) are
surfaced as a **possible duplicate** banner for a human to merge or dismiss;
they are not auto-merged.

## A9 — Webhook idempotency is keyed on the source's own event id

`IntakeSubmission` is unique on `(sourceId, externalId)`. `externalId` is taken
from the payload (`event_id`, `submission_id`, `entry.id`, or the Google Sheet
row key); when a payload carries none, a SHA-256 of the canonicalised body is
used. A replay therefore updates one row and produces no second lead and no
second activity entry.

## A10 — Webhook authentication is a per-source shared secret

Each `IntakeSource` holds a SHA-256 of a secret shown once at creation. Callers
send it as `X-Intake-Signature: sha256=<hmac of the raw body>`. This is the
lowest-friction scheme that works with Google Forms/Apps Script, Zapier and
generic form posts. Unsigned requests are rejected with 401 and logged.

## A11 — Consent gates outbound messaging

`Consent` already models `ELECTRONIC_COMMUNICATION` and `TCPA_CONTACT`. Sending
SMS requires a live `TCPA_CONTACT` consent; sending email requires
`ELECTRONIC_COMMUNICATION`. Absent consent, the composer is disabled with the
reason shown, and the API refuses the send. An inbound `STOP` sets an opt-out
that blocks further sends on that channel.

## A12 — AI output is never client data until a human accepts it

Extraction writes to `ExtractedField`, which is a *proposal* table. Nothing in
`Client`, `CysFieldValue` (at `VERIFIED`) or a generated package can originate
from an `UNVERIFIED` field. Confidence is displayed everywhere a value is shown;
below 70 the field is flagged for mandatory review. No credit, financing, legal
or eligibility decision is made automatically — the system only assembles
evidence for a person to decide on.

## A13 — Single organization in the MVP, but every query is tenant-scoped

The seed creates one organization. Every model that can belong to a tenant
carries `organizationId`, and `clientScope()` in `src/lib/rbac.ts` is the single
source of truth for row visibility. New queries must spread it rather than
filter by hand.

## A14 — Synthetic data only

`prisma/seed.ts` is deterministic (fixed-seed PRNG) and contains no real people,
phone numbers, addresses or financial details. Nothing in this repository is
production client data.

## A15 — Roles map to the eight existing `RoleKey` values

`SUPER_ADMIN, ADMIN, REGIONAL_MANAGER, SALES_MANAGER, CLOSER,
DOCUMENT_COLLECTOR, MARKETING, CLIENT`. Permissions are rows
(`Permission` / `RolePermission`), so role capability is editable without a
deploy. Authorization is enforced on the server in every route handler, server
action and page — never only by hiding navigation.

---

## Open questions that did not block the build

These were answered by assumption above; a different answer changes
configuration, not structure.

1. Which specific forms and Google Sheets are in use today, and what are their
   exact column headers? — the field map is data, so a real sheet is wired up by
   editing an `IntakeSource`, not by changing code.
2. What are the exact required CYS fields **on the Vercel portal**? — seeded with
   a documented starter set derived from the solar-cancellation workflow and
   editable in Settings → CYS field map. Reconciling it against the portal's real
   intake form is the one open item that needs a person with portal access; no
   attempt is made to obtain Vercel or Supabase credentials.
3. Which email and SMS vendors will be used? — adapters are swappable; mock until
   credentials arrive.
4. What retention period applies to uploaded documents? — a configurable
   `documentRetentionDays` org setting defaults to 2,555 days (7 years); nothing
   is auto-deleted until it is set deliberately.
