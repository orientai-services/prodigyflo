#!/bin/bash
set -euo pipefail
DOMAIN=prodigyflo.ai
APP=/opt/prodigyflo/app
REPO=/opt/prodigyflo/repo
BRANCH=p0-mvp
# ── source ── (git-fetch mode when a repo clone exists; tarball otherwise)
mkdir -p "$APP"
COMMIT=""
if [ -d "$REPO/.git" ]; then
  echo "source: git fetch ($REPO, origin/$BRANCH)"
  git -C "$REPO" fetch origin "$BRANCH" --quiet
  COMMIT=$(git -C "$REPO" rev-parse "origin/$BRANCH")
  git -C "$REPO" archive "origin/$BRANCH" | tar -x -C "$APP"
else
  echo "source: tarball (/opt/prodigyflo/src.tar.gz)"
  tar -xzf /opt/prodigyflo/src.tar.gz -C "$APP"
fi

# ── prune files the branch no longer has ──
# `tar -x` only ADDS and overwrites; it never removes. A file deleted from the
# branch therefore lingers in $APP forever, and a stale source file breaks the
# next typecheck (or worse, keeps serving a route that no longer exists). Scoped
# to src/ and prisma/migrations/ on purpose: those are the trees where a leftover
# is harmful, and it leaves generated artefacts (next-env.d.ts, tsbuildinfo,
# .next, node_modules, .env) untouched.
if [ -d "$REPO/.git" ] && [ -d "$APP/src" ]; then
  git -C "$REPO" ls-tree -r --name-only "origin/$BRANCH" | sort > /tmp/pf-intree.txt
  (cd "$APP" && find src prisma/migrations -type f 2>/dev/null | sort) > /tmp/pf-ondisk.txt
  STALE=$(comm -23 /tmp/pf-ondisk.txt /tmp/pf-intree.txt || true)
  if [ -n "$STALE" ]; then
    echo "pruning files no longer in the branch:"
    echo "$STALE" | sed 's/^/  - /'
    echo "$STALE" | while IFS= read -r f; do [ -n "$f" ] && rm -f "$APP/$f"; done
    find "$APP/src" "$APP/prisma/migrations" -type d -empty -delete 2>/dev/null || true
  fi
fi

# ── env (created once; survives redeploys) ──
if [ ! -f /etc/prodigyflo.env ]; then
  # Both secrets are minted here and never leave the box.
  AUTH_SECRET=$(openssl rand -base64 32)
  DB_PASS=$(openssl rand -hex 24)
  sudo -u postgres psql -c "ALTER ROLE prodigyflo PASSWORD '${DB_PASS}'" >/dev/null
  cat > /etc/prodigyflo.env <<ENV
DATABASE_URL="postgresql://prodigyflo:${DB_PASS}@127.0.0.1:5432/prodigyflo?schema=public"
AUTH_SECRET="${AUTH_SECRET}"
AUTH_TRUST_HOST="true"
AUTH_URL="https://${DOMAIN}"
APP_URL="https://${DOMAIN}"
AI_PROVIDER="mock"
EMAIL_PROVIDER="mock"
SMS_PROVIDER="mock"
SHEETS_PROVIDER="mock"
FILE_STORAGE_DRIVER="local"
FILE_STORAGE_LOCAL_DIR="/opt/prodigyflo/storage/documents"
FILE_SIGNED_URL_TTL="300"
NODE_ENV="production"
ENV
  chmod 600 /etc/prodigyflo.env
fi
# Deploy-console config (additive; appended once, never rewrites existing keys).
if ! grep -q '^DEPLOY_SCRIPT=' /etc/prodigyflo.env; then
  cat >> /etc/prodigyflo.env <<ENV
DEPLOY_SCRIPT="/opt/prodigyflo/deploy.sh"
DEPLOY_LOG="/opt/prodigyflo/deploy.log"
DEPLOY_REPO_DIR="/opt/prodigyflo/repo"
ENV
fi
cp /etc/prodigyflo.env "$APP/.env"

# ── build ──
cd "$APP"
npm ci --no-audit --no-fund 2>&1 | tail -2
npx prisma generate >/dev/null
npx prisma migrate deploy 2>&1 | tail -3
# `tail -4` keeps the deploy log readable, but pipefail means a failed build
# still aborts the script — and the last four lines are usually trace warnings
# rather than the error, so keep the full output for diagnosis.
NODE_OPTIONS="--max-old-space-size=3072" npm run build > /opt/prodigyflo/build.log 2>&1 || {
  echo "BUILD FAILED — last 30 lines:"
  tail -30 /opt/prodigyflo/build.log
  exit 1
}
tail -4 /opt/prodigyflo/build.log

# ── build stamp ──
# Written only AFTER a successful build: a stamp saved up front survives a
# failed deploy and then claims a commit that is not actually being served,
# which is exactly how a broken deploy hides itself.
cat > "$APP/BUILD_INFO.json" <<JSON
{ "commit": "${COMMIT:-unknown}", "branch": "${BRANCH}", "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
JSON
# The demo seed TRUNCATES EVERYTHING — it may only ever run on an empty
# database. Real data (users, invites, leads) must survive every deploy.
ORG_COUNT=$(sudo -u postgres psql -d prodigyflo -tAc 'SELECT COUNT(*) FROM "Organization"' 2>/dev/null || echo 0)
if [ "$ORG_COUNT" = "0" ]; then
  npx tsx prisma/seed.ts 2>&1 | tail -3
else
  echo "seed skipped — database has data (orgs: $ORG_COUNT)"
  # Templates are safe to sync: pure upserts, never deletes.
  npx tsx prisma/sync-templates.ts 2>&1 | tail -2
fi

# ── systemd ──
cat > /etc/systemd/system/prodigyflo.service <<'UNIT'
[Unit]
Description=ProdigyFlo (Sales Client Overview)
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/prodigyflo/app
EnvironmentFile=/etc/prodigyflo.env
Environment=PORT=3050
ExecStart=/usr/bin/npx next start -p 3050
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable prodigyflo
# enable --now does NOT restart a running unit — a redeploy would keep serving
# the previous build and the previous environment.
systemctl restart prodigyflo
sleep 6
systemctl is-active prodigyflo

# ── nginx (first deploy only — certbot rewrites this file for TLS, and a
# redeploy must never clobber that) ──
if [ ! -f /etc/nginx/sites-available/prodigyflo ]; then
cat > /etc/nginx/sites-available/prodigyflo <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    client_max_body_size 30m;
    location / {
        proxy_pass http://127.0.0.1:3050;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX
ln -sf /etc/nginx/sites-available/prodigyflo /etc/nginx/sites-enabled/prodigyflo
rm -f /etc/nginx/sites-enabled/default
fi
nginx -t && systemctl reload nginx
echo DEPLOY_OK
