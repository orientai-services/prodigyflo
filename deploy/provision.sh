#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get install -yq nginx postgresql postgresql-contrib ufw

# Node 22 from NodeSource
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi
node -v

# Firewall: ssh + http/https only
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# Postgres role + database (password comes in via env)
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='prodigyflo'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE ROLE prodigyflo LOGIN PASSWORD '${DB_PASS}'"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='prodigyflo'" | grep -q 1 || \
  sudo -u postgres createdb -O prodigyflo prodigyflo

mkdir -p /opt/prodigyflo
echo provisioned
