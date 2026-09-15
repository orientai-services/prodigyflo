#!/bin/sh
# Synthetic Stage 0 integration tests; never loads production configuration.
# Usage: sh scripts/test-stage0-local.sh /absolute/path/to/node24 [vitest options]
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node_bin=${1:?Provide an absolute Node 24 executable path}
shift
case "$node_bin" in /*) ;; *) echo 'Absolute Node executable required' >&2; exit 1;; esac
[ "$("$node_bin" -p 'process.versions.node.split(".")[0]')" = 24 ] || { echo 'Node 24 required' >&2; exit 1; }
case "$repo" in */stage0/prodigyflo) ;; *) echo 'Isolated Stage 0 worktree required' >&2; exit 1;; esac
for app in "$repo" "$repo/../scs"; do
  for file in "$app"/.env*; do
    case "$file" in */.env.example|*/.env.local.example) continue;; esac
    [ ! -f "$file" ] || { echo 'Remove local dotenv configuration before isolated tests' >&2; exit 1; }
  done
done
cd "$repo"
exec env -i PATH="$PATH" HOME="$HOME" STAGE0_TESTS=01a09fc2 PG_POOL_MAX=1 \
 DATABASE_URL=postgresql://stage0@127.0.0.1:55482/pf_stage0_01a09fc2 \
 FILE_STORAGE_DRIVER=local FILE_STORAGE_LOCAL_DIR=/private/tmp/scs-pf-stage0-01a09fc2/pf-storage \
 SCS_STAGE0_WORKTREE="$(CDPATH= cd -- "$repo/../scs" && pwd)" AUTH_SECRET=synthetic-stage0-secret \
 "$node_bin" node_modules/vitest/vitest.mjs run \
 tests/stage0-handoff.test.ts tests/stage0-controls.test.ts tests/intake.test.ts tests/documents.test.ts \
 src/lib/intake/scs-document-import.test.ts src/lib/intake/scs-packet.test.ts \
 src/lib/intake/token-auth.test.ts "$@"
