# Deploying ProdigyFlo

Current target: **Vercel + Supabase**. DigitalOcean droplet scripts in this folder are legacy and must not be run against Vercel.

Production: **https://prodigyflo.ai** (canonical; prodigyflo.com, www and prodigyflo.vialab.app 301 to it).

## Vercel + Supabase

Two Vercel projects (this app and SCS Intake), two Postgres databases — do not merge them. Do not add a browser Supabase client; Prisma stays server-only.

1. Create a Supabase project. Runtime `DATABASE_URL` = transaction pooler (`:6543`, `sslmode=require`). `DIRECT_URL` = direct host (`db.<ref>.supabase.co:5432`) for `prisma migrate deploy`.
2. `FILE_STORAGE_DRIVER=s3` with `FILE_STORAGE_*` pointed at Supabase Storage's S3 API (`https://<ref>.storage.supabase.co/storage/v1/s3`) or any other S3-compatible bucket. Local disk is refused in production and on Vercel.
3. Set `CRON_SECRET` (and/or `JOBS_TOKEN`). `vercel.json` pings `GET /api/jobs/run` every 5 minutes with `Authorization: Bearer $CRON_SECRET`. Inbound webhooks still HMAC with `JOBS_TOKEN`. (`*/5` crons and `maxDuration = 300` need Vercel Pro.)
4. Set `AUTH_URL` / `APP_URL` to the Vercel production host. `SHOW_DEMO_ACCOUNTS=false`.
5. Run `DIRECT_URL=… npx prisma migrate deploy` once against the direct host, then deploy. Do not run migrate from preview deployments that share production.

The in-app deploy console (`src/lib/deploy.ts`) stays mock unless `/opt/prodigyflo/deploy.sh` exists — it will not go live on Vercel.

## Legacy droplet (do not use for new deploys)

Previous production was DigitalOcean droplet `prodigyflo` (64.23.190.77, sfo3, s-1vcpu-2gb + 3 GB swap).

## Redeploy

```bash
git archive --format=tar.gz -o /tmp/src.tar.gz p0-mvp
scp /tmp/src.tar.gz root@64.23.190.77:/opt/prodigyflo/src.tar.gz
ssh root@64.23.190.77 'nohup bash /root/deploy.sh > /root/deploy.log 2>&1 &'
```

`deploy.sh` is idempotent: unpack → env (created once, secrets minted on the
box) → npm ci → migrate → build → seed → systemd restart → nginx (first run
only — certbot owns the vhost afterwards).

## Hard-won rules

- **Run the build detached.** A dropped SSH session killed the first deploy.
- **Never build without swap.** `next build` OOM-kills on 2 GB RAM.
- **`systemctl enable --now` does not restart a running unit.** The script
  uses an explicit `restart`, or a redeploy serves the old build forever.
- **Never rewrite the nginx vhost after certbot has.** The vhost block is
  guarded with `[ ! -f ... ]`; `restore_tls.sh` repairs it if clobbered.
- `SHOW_DEMO_ACCOUNTS=false` in `/etc/prodigyflo.env` keeps demo credentials
  off the public login page.

Fresh-server setup order: `provision.sh` → deploy → `certbot --nginx` (see
`restore_tls.sh` for the exact invocation).
