# Stage 0 handoff repair — local candidate only

SCS intake updates serialize per intake source in a database transaction. Receipt, client binding and queued document metadata commit together. Stable source case identity takes precedence over changing contact details; ambiguous historical bindings are held for reconciliation. Exact legacy delivery/portal matches can adopt the existing receipt while preserving its ID and original receipt time. Generic intake retains its existing processing path.

Document copying stays asynchronous. Imports validate source case/document identity, fence worker completion and recover interrupted workers after ten minutes. The eight-attempt cap remains; exhausted rows are not reset. Failed database persistence removes that attempt's uncommitted file when possible; a failed storage deletion still requires orphan reconciliation. Reject credentials shared across multiple receiving workspaces rather than choosing one arbitrarily.

`SCS_DOCUMENT_IMPORTS_PAUSED=true` holds document import work before claims/recovery. Receipt and metadata queueing continue. Unset/false retains current behavior. This does not pause extraction or other job types. The original deployment ignores this new flag; an approved worker hold outside that old deployment is required before rollback to it. No schema migration is included.

## Verification

The cross-repository synthetic integration test is `prodigyflo/tests/stage0-handoff.test.ts`; the SCS harness is `scs/scripts/stage0-server.ts`. The workspace-level `../run-tests.sh` supplies an empty environment plus explicit loopback-only database/storage settings. It runs 83 tests including 18 real database/HTTP/file integration cases. Production credentials must never be supplied to this harness.

Both projects passed production-mode builds and TypeScript validation using Node 22.22.3. SCS also passed its existing `npm run check` gates. The workspace report has exact evidence and deployment baselines.

## Release restriction

No push, merge, production configuration edit, migration, job replay or deployment is authorized by this local work. Production authentication is still mismatched. Confirm the target receiving workspace, restore readiness and paired export credentials before a separately approved rollout. Install and verify worker holds before credential alignment; enabling authentication can otherwise resume scheduled delivery.

Rollback means preserving the current databases, files and incoming queues while restoring compatible application code/configuration. Never restore an old database over new incoming leads. A production end-to-end smoke test and live deployment SHA verification remain required.
