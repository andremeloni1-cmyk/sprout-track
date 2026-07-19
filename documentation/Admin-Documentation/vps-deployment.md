# VPS Deployment (Docker + Automatic HTTPS)

This guide walks through deploying Sprout Track on a Virtual Private Server so it
is reachable on the public internet over HTTPS. It uses
[`docker-compose.production.yml`](../../docker-compose.production.yml), which runs
two containers:

- **app** — Sprout Track itself (SQLite by default; PostgreSQL optional)
- **caddy** — a [Caddy](https://caddyserver.com/) reverse proxy that terminates
  TLS and **automatically obtains and renews a free Let's Encrypt certificate**
  for your domain

All persistent data lives under a single `./data` directory, so backups are a
simple `tar`.

> **Why a reverse proxy?** HTTPS is required for the "install as app" (PWA)
> experience, secure login cookies, and push notifications. Caddy gives you
> hands-off HTTPS with no manual certificate steps.

---

## What you need

- A VPS running a modern Linux (this guide uses **Ubuntu/Debian**; other distros
  work with equivalent commands) with root/`sudo` access.
- **Recommended:** a domain name (e.g. `baby.example.com`) you can point at the
  VPS. You can also run [without a domain](#running-without-a-domain-http-only),
  but HTTPS-only features (PWA install, push notifications) will not work.
- Ports **80** and **443** open to the internet (for HTTP/HTTPS + certificate
  issuance).

---

## Step 1 — Point your domain at the VPS

Create a DNS record for your (sub)domain pointing at the VPS's public IP:

| Type | Name | Value |
|------|------|-------|
| `A` | `baby.example.com` | `<your VPS IPv4>` |
| `AAAA` *(if you have IPv6)* | `baby.example.com` | `<your VPS IPv6>` |

Let's Encrypt validates over HTTP/HTTPS, so DNS must resolve **before** you start
the stack. Verify with `dig +short baby.example.com` (or `ping`).

---

## Step 2 — Install Docker

Install Docker Engine + the Compose plugin using Docker's official convenience
script:

```bash
curl -fsSL https://get.docker.com | sudo sh
```

Confirm both are available:

```bash
docker --version
docker compose version
```

*(Optional)* run Docker without `sudo`: `sudo usermod -aG docker $USER`, then log
out and back in.

---

## Step 3 — Get the code

```bash
git clone https://github.com/Oak-and-Sprout/sprout-track.git
cd sprout-track
```

---

## Step 4 — Configure your environment

Copy the sample and edit it:

```bash
cp .env.production.sample .env
nano .env    # or your editor of choice
```

Set at least:

```env
DOMAIN=baby.example.com
TZ=America/New_York
APP_URL=https://baby.example.com
```

- `DOMAIN` — the domain from Step 1. Setting it enables automatic HTTPS.
- `TZ` — your timezone ([list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)).
- `APP_URL` — your full `https://` URL; used by the push-notification cron job.

Leave the database section commented to use **SQLite** (recommended). For
PostgreSQL, see [Using PostgreSQL](#using-postgresql-instead-of-sqlite).

---

## Step 5 — Open the firewall

If you use `ufw`:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

The app's own port (3000) is **not** published to the host — Caddy is the only
public entry point — so you do not open 3000.

---

## Step 6 — Launch

```bash
docker compose -f docker-compose.production.yml up -d
```

The first start pulls the images, generates secrets (`JWT_SECRET`, `ENC_HASH`,
`NOTIFICATION_CRON_SECRET`) into `./data/env/.env`, runs database migrations,
seeds defaults, and — once `DOMAIN` resolves — Caddy fetches your TLS
certificate.

Watch progress:

```bash
docker compose -f docker-compose.production.yml logs -f
```

When the app logs `Starting application...` and Caddy has a certificate, open
**https://baby.example.com**.

---

## Step 7 — First-time setup

On first access, the **Setup Wizard** guides you through family, security, and
baby setup. Default credentials:

- Family login PIN: `111222`
- Family Manager admin password (`/family-manager`): `admin`

Change these during setup. See [Initial Setup](initial-setup.md) for details.

---

## Step 8 — Tell the app it is on HTTPS

Some links the app generates (family invite links, share links, and email links)
are built from settings stored in the database, not from the reverse proxy. Set
them once:

1. Go to **`https://baby.example.com/family-manager`** and log in with the admin
   password.
2. Open **App Configuration**.
3. Set **Root Domain** to `baby.example.com` and enable **HTTPS**.
4. Save.

Invite/share/email links will now use `https://baby.example.com`.

---

## Step 9 — Harden login cookies (recommended)

By default the app does not mark auth cookies as HTTPS-only (`COOKIE_SECURE` is
`false`) so that HTTP/IP setups keep working. Once you are on HTTPS, enable it:

```bash
sudo sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=true/' data/env/.env
docker compose -f docker-compose.production.yml restart app
```

> `COOKIE_SECURE` and `TZ` are stored in `./data/env/.env` (written on first
> boot) and are read from there — not from `.env` — so edit that file and
> restart the app to change them. Only the `DATABASE_*` variables can be
> overridden from `.env` after first boot.
>
> **Do not** set `COOKIE_SECURE=true` if you are running HTTP-only (no domain) —
> browsers will drop the cookies and logins will fail.

---

## Step 10 — Push notifications (optional)

The notification infrastructure is already built into the container
(`ENABLE_NOTIFICATIONS=true`) and `APP_URL` was set in Step 4. To turn
notifications on, open **Family Manager → App Configuration → Notifications** and
enable them — VAPID keys are generated automatically. Each caretaker then opts in
from their device (HTTPS required). See
[Push Notifications](push-notifications.md) for the full reference.

---

## Operating the deployment

All commands run from the repo directory. Define a short alias to save typing:

```bash
alias stc='docker compose -f docker-compose.production.yml'
```

| Task | Command |
|------|---------|
| View logs | `stc logs -f` |
| Restart the app | `stc restart app` |
| Stop everything | `stc down` |
| Start again | `stc up -d` |
| Status | `stc ps` |

### Upgrading

```bash
git pull
docker compose -f docker-compose.production.yml pull
docker compose -f docker-compose.production.yml up -d
```

The new container automatically runs migrations and adds any new environment
defaults on startup. Your data in `./data` is untouched. See
[Upgrades and Backups](upgrades-and-backups.md).

### Backups

Everything stateful lives under `./data` (SQLite database, secrets/`.env`,
uploaded files, and Caddy's certificates). Back it up with a stopped stack for a
consistent snapshot:

```bash
docker compose -f docker-compose.production.yml stop
sudo tar czf sprout-track-backup-$(date +%F).tar.gz data/
docker compose -f docker-compose.production.yml start
```

You can also use the built-in backup/restore in **Family Manager**, which
includes the database and `.env` (and therefore your `ENC_HASH`/`JWT_SECRET`).

> Keep a copy of `./data/env/.env` somewhere safe. Losing `ENC_HASH` makes
> encrypted files unrecoverable; changing `JWT_SECRET` logs everyone out.

---

## Running without a domain (HTTP only)

If you do not have a domain yet, leave `DOMAIN` empty in `.env`. Caddy then
serves plain HTTP on port 80 and you reach the app at `http://<your-vps-ip>`.

In this mode:

- Keep `COOKIE_SECURE=false` (the default) or logins will fail.
- Leave **HTTPS** disabled in App Configuration; set **Root Domain** to your IP.
- Push notifications and PWA install will **not** work (they require HTTPS).

When you later add a domain: point DNS at the VPS, set `DOMAIN` and `APP_URL` in
`.env`, run `stc up -d`, then complete Steps 8–10.

---

## Using an existing reverse proxy

If the VPS already runs its own reverse proxy (a host **nginx**, Traefik, a
Cloudflare Tunnel, or a control panel) terminating TLS for other sites, do **not**
use the Caddy stack — it would fight for ports 80/443. Instead use
[`docker-compose.nginx.yml`](../../docker-compose.nginx.yml), which runs only the
app on a loopback port and lets your existing proxy front it.

1. Pick a **free** loopback port. The default is `3010`; if that is taken, set
   `APP_LOCAL_PORT` in `.env`. Check what is already in use with:

   ```bash
   sudo ss -tlnp | grep -E ':30[0-9][0-9]'
   ```

2. Start just the app (no Caddy, ports 80/443 untouched):

   ```bash
   docker compose -f docker-compose.nginx.yml up -d
   ```

3. Add a virtual host to your existing proxy pointing at
   `http://127.0.0.1:3010` (or your `APP_LOCAL_PORT`). Example nginx site
   (`/etc/nginx/sites-available/sprout-track`, then symlink into
   `sites-enabled/`):

   ```nginx
   server {
       listen 80;
       listen [::]:80;
       server_name baby.example.com;

       client_max_body_size 25m;   # allow vaccine-document uploads

       location / {
           proxy_pass http://127.0.0.1:3010;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
       }
   }
   ```

4. Enable it and obtain a certificate with your usual tooling:

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d baby.example.com
   ```

   `certbot --nginx` adds the `listen 443 ssl` block, installs the certificate,
   and redirects HTTP → HTTPS automatically.

Complete Steps 7–10 as normal (they are proxy-independent).

---

## Using PostgreSQL instead of SQLite

SQLite is recommended for most deployments. To use the bundled PostgreSQL
container instead, edit `.env` and uncomment the database section, using the
**same strong password** in all three places:

```env
DATABASE_PROVIDER=postgresql
POSTGRES_PASSWORD=CHANGE_ME_STRONG_PASSWORD
DATABASE_URL=postgresql://sprout:CHANGE_ME_STRONG_PASSWORD@db:5432/sprout_track
LOG_DATABASE_URL=postgresql://sprout:CHANGE_ME_STRONG_PASSWORD@db:5432/sprout_track_logs
```

Then start the stack **with the `postgres` profile** so the database container
runs too:

```bash
docker compose -f docker-compose.production.yml --profile postgres up -d
```

The bundled Postgres stores its data in `./data/postgres` and creates both the
`sprout_track` and `sprout_track_logs` databases on first start. The app waits
for the database to be ready before migrating. To point at an **external**
managed PostgreSQL instead, set the URLs to that server and start **without** the
`postgres` profile (so no local database container runs).

---

## Troubleshooting

**Certificate not issued / HTTPS not working**
- Confirm DNS resolves to the VPS: `dig +short baby.example.com`.
- Confirm ports 80 and 443 are open and not used by another web server
  (`sudo ss -tlnp | grep -E ':80|:443'`). Stop any host nginx/Apache first.
- Check Caddy logs: `docker compose -f docker-compose.production.yml logs caddy`.
- Let's Encrypt has rate limits; avoid repeated restarts while debugging. For
  testing you can add the staging CA in the Caddyfile.

**502 Bad Gateway from Caddy**
- The app may still be starting. Check `stc ps` and `stc logs app`. Caddy waits
  for the app's healthcheck, but a crashed app (e.g. bad `DATABASE_URL`) shows as
  502.

**Logins fail after enabling HTTPS**
- Ensure you are visiting the `https://` URL. If you set `COOKIE_SECURE=true`,
  the app is reachable over HTTPS only.

**Can't reach the site at all**
- Verify the firewall (Step 5) and that your VPS provider's network/security
  group also allows 80/443.

---

## Related documentation

- [Docker Deployment](docker-deployment.md) — volumes, ports, container details
- [Environment Variables](environment-variables.md) — full variable reference
- [Initial Setup](initial-setup.md) — Setup Wizard and default credentials
- [Push Notifications](push-notifications.md) — notification setup
- [Upgrades and Backups](upgrades-and-backups.md) — upgrades, backup/restore,
  switching database providers
