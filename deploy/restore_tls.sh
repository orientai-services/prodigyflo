#!/bin/bash
set -euo pipefail

cat > /etc/nginx/sites-available/prodigyflo <<'NGINX'
server {
    listen 80;
    server_name prodigyflo.com www.prodigyflo.com prodigyflo.vialab.app;
    client_max_body_size 30m;
    location / {
        proxy_pass http://127.0.0.1:3050;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX
ln -sf /etc/nginx/sites-available/prodigyflo /etc/nginx/sites-enabled/prodigyflo
nginx -t && systemctl reload nginx

# The certificate already exists; --reinstall wires it back into the vhost.
certbot install --cert-name prodigyflo.com --nginx --non-interactive --redirect 2>&1 | tail -3
nginx -t && systemctl reload nginx
echo TLS_RESTORED
