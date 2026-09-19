# Team Prodigy implementation and release record

Approved scope: one Team Prodigy workspace, Super Admin and assigned-client Closer roles, complete 42-item CYS profiles, document-module upload/preview, complete role-scoped calendars, preserved Meridian history, and retirement of Engine-only runtime work.

Canonical base: `orientai-services/prodigyflo` main `b173ee91dee38d87f18f0a356e9d67af8feb9b74`; Vercel `prodigyflo-42` / `prj_SIPQJtji6NWlfyuK5l5tyvwC5GE8`. This isolated checkout is an implementation branch of that existing repository, not a new production source.

## Locked decisions

- Keep SCS and Prodigyflo repositories/databases separate. Preserve intake source IDs, replay behavior, original answers, private files, and extraction/review evidence.
- Super Admin absorbs Owner authority. All three current Team Prodigy staff become Super Admins. Meridian logins become inactive historical identities; do not delete their authorship.
- One current Closer per client; upcoming appointments follow reassignment, historical appointment attribution stays intact. Assignment scope cannot be widened through permission settings.
- All 42 existing CYS definitions remain visible. Initial eight SCS identity/address fields and any additional known values populate; missing answers can be entered by authorized staff. Preserve current required/conditional closing rules.
- Document modules allow upload and quick view, retaining previous files/versions. Provider failure does not discard stored files.
- Existing working extraction/public-record integrations stay in place. The separate Records Worker/analyzer is not a proven replacement; no provider switch or unrelated feature import.
- Preserve all client records during organization consolidation. No contact-based automatic deduplication; no destructive cascading organization deletion.

## Release gates

1. Canonical-source check, tests, typecheck, clean build, and blocking CI.
2. Isolated database/storage, two-Closer authorization tests, CYS and document tests, calendar and replay tests.
3. Migration rehearsal against a database copy; row/relationship/file manifests, restore rehearsal, and explicit collision handling. Fresh production snapshot at cutover.
4. Protected Vercel Preview using isolated dependencies. No production connectors or outbound communications in tests.
5. Controlled write/job pause, migration, verification, canonical GitHub main deployment, and resumed queued delivery. A coordinated code/data rollback must preserve post-cutover arrivals.

Implementation and production status must be reported separately. Passing unit tests is not proof of production deployment or a completed data migration.

## Candidate behavior and verification

Implemented on `codex/prodigy-workspace-01a0b8f2`:

- Password and magic-link sessions admit only active Super Admin/Closer identities. Every request reloads the current role permissions; Owner flags and historical assignments cannot widen Closer access.
- Only Super Admin can assign/reassign clients. Manual/CSV and intake defaults accept only active Closers; legacy overview edits cannot bypass the assignment transaction. Changes are serialized with staff deactivation. Future live appointments follow the client; completed and past appointments retain authorship. Unassigned appointments remain visible to Admins.
- Client profiles contain the complete 42-item CYS checklist, manual verification/correction, module uploads, previews, and previous file versions. Document presence comes from actual uploaded files and their review state. Unknown files remain accessible under Other documents.
- CYS page reads perform **zero mirror/readiness writes**. Source refresh uses one conditional batch upsert that preserves human-verified answers. Queue resolves current sources in batches, independent of previous profile visits.
- Removed Engine UI, scheduler, runner, insight rules, AI organization-insight provider methods, and Engine-only retrieval. The jobs endpoint reports Engine `RETIRED`; extraction, SCS imports, and client-specific Closer Briefs remain.
- Retired public self-registration and agency switching. The local demo seed is now non-destructive and creates only the two staff roles in Team Prodigy.

Local verification: 974 unit/integration tests passed across 85 files; 3 browser scenarios passed (actual staff login, scoped calendars, all 42 fields, saving/reloading a missing answer, direct-route denial, inactive-login denial). Typecheck, lint, canonical-source check, and production build passed. Browser server logs contain cancelled-stream messages during rapid navigation; assertions completed successfully. This is not a live latency benchmark.

The migration tests prove transaction rollback, collision refusal, preservation of separate clients sharing contact details, historical authorship, immutable document rows, manual CYS corrections, inactive legacy users, two active roles, one team, and preservation of the target connector configuration. A local synthetic database backup was restored into a separate empty database; all 79 public tables matched by row count and content digest. The backup and evidence are held outside Git. **Production-data rehearsal and isolated Vercel Preview are not yet complete.**

The `Workspace checks` GitHub workflow runs migrations, typecheck, lint, all tests, production build, and the browser suite against disposable PostgreSQL. It does not contain production credentials. Branch protection must require this workflow before release; adding the workflow alone does not configure that GitHub setting.

## Migration operator procedure

The entry point is `npm run workspace:merge -- --source SOURCE_ID --target TARGET_ID`. It reads **only** explicitly supplied `MIGRATION_DATABASE_URL`. Without `--commit` it executes the complete transaction and rolls back. Even dry runs lock tables: run first against an isolated restored copy, not a live intake database.

Before any remote commit:

1. Confirm source Meridian and destination Team Prodigy IDs from the approved production manifest. Capture current row counts, client IDs, relationships, storage-key/checksum manifest, and intake replay/import identities. Keep full snapshots and credentials outside Git.
2. Create a production database backup with explicit approval of its sensitive contents and local destination; preserve the existing document objects. Restore into an isolated database, disable all outbound integrations/jobs, and verify row counts and hashes before running the rehearsal. Do not point an isolated app at production storage for uploads.
3. Run the dry run, then commit in the restored copy. Check its report, client ownership, historical appointments, all 42 definitions, connector credentials/configuration, and SCS source IDs. Rehearse restoring the original snapshot and verify the manifest again.
4. Provision protected Preview with separate database, storage, auth secret, vault key/configuration, and synthetic provider settings. Exercise an SCS delivery through its separate database/queue, document failure/retry, reassignment, and CYS. Production SCS database and routing remain separate.
5. During the approved cutover window, pause PF writers/jobs and SCS delivery, retain new SCS arrivals in its durable queue, take a fresh backup, apply the two additive Prisma migrations, and commit the workspace merge. Inspect the report before resuming anything. Release the matching code through canonical GitHub main/Vercel, verify, then resume and replay queued intake.

A remote `--commit` requires `--evidence /private/path/evidence.json` with:

```json
{
  "sourceId": "approved-source-id",
  "targetId": "approved-target-id",
  "revision": "exact-reviewed-git-head",
  "createdAt": "fresh-backup-UTC-time",
  "backupPath": "/private/path/production-backup.dump",
  "backupSha256": "sha256-of-that-file",
  "restoreVerified": true,
  "previewVerified": true,
  "writesAndJobsPaused": true
}
```

The CLI verifies matching organizations/revision, backup checksum/freshness, direct port 5432, and these operator attestations. The booleans are **attestations**, not automated proof; retain the actual rehearsal/Preview evidence with them. Never set them to bypass unfinished gates.

The merge aborts for unexpected organization tables, child organizations, user identity collisions, conflicting external identifiers, unreconciled legacy phone billing, missing target stages, or an incomplete 42-field map. It retains immutable snapshots of every changed organization-owned row and relevant child/config rows in `WorkspaceMigrationArchive`, which has no cascading organization FK and no app endpoint. Sensitive archived credentials remain inside the database. Target integrations remain authoritative; legacy sources/connectors/sequences are disabled and pending legacy messages cancelled. Legacy wallet/credential/config rows removed for uniqueness are archived; active financial obligations stop the run instead.

## Rollback and remaining retirement gates

Before commit, any failure rolls back the complete transaction. After commit, roll back **code and database together**, with writers and jobs still paused. Restore the pre-cutover backup into a fresh database, compare the manifest, repoint the previous known-good release, then replay preserved SCS arrivals. Do not overwrite post-cutover records: if writes were resumed, first capture and reconcile that delta. The immutable archive supports investigation; it is not a substitute for a tested full backup.

Engine tables (`EngineRun`, `EngineStep`, `Insight`) and the legacy role enum remain physically present for the compatibility/rollback window. Their active runtime has been removed. **Do not drop them in the cutover migration.** After the production rehearsal and observation window, archive their final contents, verify no readers/writers/monitors remain, and apply a separate reviewed table-removal migration. Other legacy modules are retained until their dependencies are proven unused; they were not all removed merely because they lack sidebar links.

The Records Worker/analyzer remains a candidate, not an adopted replacement. Its connection to live SCS intake has not been demonstrated. Preserve real-document versus summary/search-assistance provenance in any subsequent adoption work. No separate Records analyzer credentials or provider replacement are introduced by this candidate.

Automatic deployment is disabled **only for this implementation branch** using Vercel's documented [branch deployment configuration](https://vercel.com/docs/project-configuration/git-configuration#gitdeploymentenabled). Re-enable it after isolated Preview dependencies are configured. This setting does not change main or another branch.

## Current release blocker

Automatic approval review rejected exporting the full production database locally because the payload includes client data, password hashes, and encrypted connector credentials, and explicit approval of that payload and destination was missing. The rejected export was not retried or performed through another mechanism. All current migration and restore tests use synthetic local data. Obtain approval for the exact backup destination before production-data rehearsal; production migration, Preview verification, physical table removal, and live release remain outstanding.
