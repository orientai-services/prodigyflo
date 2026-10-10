#!/usr/bin/env bash
# Fail loudly if this checkout is not the OrientAI production app.
# Works on any machine: checks origin remote + .vercel/project.json, not the folder path.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

detect_app() {
  if [[ -f src/server/delivery/queue.ts ]]; then
    echo scs
  elif [[ -f src/lib/intake/scs-document-import.ts ]]; then
    echo pf
  else
    echo "check-canonical: cannot tell if this is scs-intake or prodigyflo" >&2
    exit 1
  fi
}

APP="${1:-$(detect_app)}"
case "$APP" in
  scs)
    WANT_REMOTE='orientai-services/scs-intake'
    WANT_PROJECT_ID='prj_faemfrbbaFkP2ReLTyhFksFqyOnb'
    WANT_PROJECT_NAME='scs-intake-42'
    WANT_PATHS='MacBook Pro: ~/Developer/SCS/scsintake | devs-Mac-mini: ~/Developer/scs-intake'
    ;;
  pf|prodigyflo)
    WANT_REMOTE='orientai-services/prodigyflo'
    WANT_PROJECT_ID='prj_SIPQJtji6NWlfyuK5l5tyvwC5GE8'
    WANT_PROJECT_NAME='prodigyflo-42'
    WANT_PATHS='MacBook Pro: ~/Developer/products/ProdigyFlo/prodigyflo-42 | devs-Mac-mini: ~/Developer/prodigyflo'
    ;;
  *)
    echo "check-canonical: unknown app '$APP' (use scs or pf)" >&2
    exit 1
    ;;
esac

fail() { echo "CANONICAL CHECK FAILED: $*" >&2; exit 1; }

REMOTE="$(git remote get-url origin 2>/dev/null || true)"
[[ -n "$REMOTE" ]] || fail "no git remote named origin"
echo "$REMOTE" | grep -q "$WANT_REMOTE" || fail "origin is '$REMOTE' — expected $WANT_REMOTE"

if [[ -f .vercel/project.json ]]; then
  PROJECT_ID="$(python3 -c 'import json,sys; print(json.load(open(".vercel/project.json")).get("projectId",""))')"
  PROJECT_NAME="$(python3 -c 'import json,sys; print(json.load(open(".vercel/project.json")).get("projectName",""))')"
  [[ "$PROJECT_ID" == "$WANT_PROJECT_ID" ]] || fail ".vercel/project.json projectId is '$PROJECT_ID' — expected $WANT_PROJECT_ID ($WANT_PROJECT_NAME)"
  if [[ -n "$PROJECT_NAME" && "$PROJECT_NAME" != "$WANT_PROJECT_NAME" ]]; then
    fail ".vercel/project.json projectName is '$PROJECT_NAME' — expected $WANT_PROJECT_NAME"
  fi
else
  echo "check-canonical: no .vercel/project.json here (ok in CI). Expected Vercel project $WANT_PROJECT_NAME ($WANT_PROJECT_ID)"
fi

echo "canonical ok: $APP"
echo "  remote  $REMOTE"
echo "  vercel  $WANT_PROJECT_NAME"
echo "  here    $ROOT"
echo "  usual   $WANT_PATHS"
# Machine-agnostic: identity is the git remote + Vercel project, never the folder path.
# Refuse known forbidden folders (docs/CANONICAL.md "Forbidden sources").
case "$ROOT" in
  */Developer/~SCS~*|*/Developer/products/scs-intake|*/Developer/products/ProdigyFlo/prodigyflo|*/Documents/ChatGPT/prodigyflo/*)
    fail "this folder is a forbidden source ($ROOT); see docs/CANONICAL.md" ;;
esac
