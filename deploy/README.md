# Deploying ProdigyFlo

Production: **https://prodigyflo.ai** (canonical; prodigyflo.com, www and prodigyflo.vialab.app 301 to it) — DigitalOcean droplet `prodigyflo`
(64.23.190.77, sfo3, s-1vcpu-2gb + 3 GB swap).

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
