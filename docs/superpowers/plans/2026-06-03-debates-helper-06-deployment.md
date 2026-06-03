# Debates Helper — Plan 6: Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `deploy/` directory and the authoritative root `docker-compose.yml` that runs all five containers on the single VPS `ZenithOfVastness`. Produce host nginx TLS termination for `debates.animeenigma.com` proxying everything to the api, a one-page VPS bootstrap runbook, a nightly Postgres backup script + rotation, certbot renewal automation, a deploy/update procedure, and a manual smoke-test checklist. This plan is **ops/config only** — no application source code changes beyond consolidating the compose stanzas that Plans 1–5 each proposed for their own service.

**Architecture:** nginx runs on the host (not containerized), terminates TLS with a Let's Encrypt certificate, and reverse-proxies all of `/` to `127.0.0.1:3000`. Express alone routes internally: `/admin/*` serves the built React SPA as static files, `/api/*` is the JSON API, `/healthz` is the health probe. The compose stack publishes only the api port, bound to loopback so nginx is the sole public ingress. The `recordings` volume is a host bind-mount (`/data/tooronkaich/recordings/`) shared by `api` and `discord-bot`. Postgres and Redis use named Docker volumes. Backups, TLS renewal, and reaping all run as host cron / certbot timers; the in-app crons (cleanup, reap, reconcile) belong to the api container (Plan 2).

**Tech Stack:** Docker Engine + compose plugin, nginx, certbot (Let's Encrypt), `pg_dump` (run inside the `postgres` container via `docker compose exec`), cron, bash, openssl, Ubuntu 22.04+ host.

**Depends on:**
- **Plan 1** — root `docker-compose.yml` (postgres, redis, api), `.env.example`, the api multi-stage `Dockerfile`, the `recordings` volume, and the api `CMD` that runs `prisma migrate deploy` on container start.
- **Plan 2** — the api domain, `/healthz`, the admin JWT auth path, and the boot-time + hourly `reconcileJobs` that makes Redis self-healing (why Redis is not backed up). The `requireAdmin` test bypass is gated on `NODE_ENV==='test'`; this plan sets `NODE_ENV=production` so it is unreachable.
- **Plan 3** — the `discord-bot` service (shares the `recordings` volume, depends on api + redis, `DISCORD_GUILD_ID` / `API_BASE_URL` env), the invite-URL bitfield (`36768768`), and the consent notice (spec §11).
- **Plan 4** — the `telegram-bot` service (depends on api + redis, `env_file: .env`, no volumes), and the BotFather Login Widget domain requirement (spec §8).
- **Plan 5** — the React admin SPA, built into `packages/api/public/admin/` and served by Express at `/admin/*`; its build step must be folded into the api image so a single api container serves both SPA and API.

**This is Plan 6 of 6.** It consolidates the per-service compose stanzas Plans 3–5 each sketched into one authoritative `docker-compose.yml`, and adds everything the host needs to run the stack publicly.

---

## File structure introduced by this plan

```
discord-debates-helper/
├── docker-compose.yml          # MODIFIED — consolidated authoritative 5-service stack
├── deploy/
│   ├── nginx.conf              # host nginx site for debates.animeenigma.com (TLS → api)
│   ├── backup.sh               # nightly pg_dump + 14-day rotation
│   └── README.md               # one-page VPS bootstrap runbook
└── packages/api/Dockerfile     # MODIFIED — fold the admin SPA build into the api image
```

> Everything under `deploy/` is committed to the repo. The `.env` file (filled with real secrets on the host) is **never** committed — `.gitignore` from Plan 1 already excludes it.

---

## Task 1: Consolidated authoritative `docker-compose.yml`

**Files:**
- Modify: `docker-compose.yml`

This replaces the incremental compose files from Plans 1, 3, 4, and 5 with one authoritative version containing all five services. Key consolidation decisions:

- **`recordings` is a host bind-mount**, not a named volume, so backups/inspection are trivial on the host: `/data/tooronkaich/recordings/` → `/var/lib/debates/recordings` in both `api` and `discord-bot`.
- **`NODE_ENV=production`** on all three app services (api, discord-bot, telegram-bot) so the Plan 2 `requireAdmin` test bypass (`x-test-admin-id`) is unreachable.
- **Only `api` publishes a port**, bound to `127.0.0.1:3000` so nginx on the host is the sole public ingress. Postgres/Redis are reachable only on the compose network (no host ports in production).
- **`restart: unless-stopped`** on every service.
- The admin SPA is served by the api container (built into the image — Task 2), so there is **no separate admin service**.

- [ ] **Step 1: Replace the entire `docker-compose.yml` with the consolidated version**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  api:
    build:
      context: .
      dockerfile: packages/api/Dockerfile
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      REDIS_URL: redis://redis:6379
      RECORDINGS_DIR: /var/lib/debates/recordings
    env_file: .env
    volumes:
      - /data/tooronkaich/recordings:/var/lib/debates/recordings
    ports:
      - "127.0.0.1:3000:3000"
    restart: unless-stopped

  discord-bot:
    build:
      context: .
      dockerfile: packages/discord-bot/Dockerfile
    depends_on:
      api:
        condition: service_started
      redis:
        condition: service_healthy
    environment:
      NODE_ENV: production
      REDIS_URL: redis://redis:6379
      API_BASE_URL: http://api:3000
      RECORDINGS_DIR: /var/lib/debates/recordings
    env_file: .env
    volumes:
      - /data/tooronkaich/recordings:/var/lib/debates/recordings
    restart: unless-stopped

  telegram-bot:
    build:
      context: .
      dockerfile: packages/telegram-bot/Dockerfile
    depends_on:
      api:
        condition: service_started
      redis:
        condition: service_healthy
    environment:
      NODE_ENV: production
      REDIS_URL: redis://redis:6379
      API_BASE_URL: http://api:3000
    env_file: .env
    restart: unless-stopped

volumes:
  pgdata:
  redisdata:
```

> **Why `recordings` is a bind-mount here but was a named `recordings:` volume in Plan 1/3:** the spec §9 storage-paths section requires audio on the host at `/data/tooronkaich/recordings/`. A bind-mount makes that path explicit and lets the admin/backups touch files directly. Both `api` and `discord-bot` mount the **same** host path, so the shared-volume contract from Plans 1–3 is preserved (the bot writes, the api reads/zips). The old named `recordings:` entry is therefore removed from the `volumes:` block.

> **Why `condition: service_started` (not `service_healthy`) for the bots' `api` dependency:** the api container's `CMD` runs `prisma migrate deploy` before listening, so it is briefly up-but-not-ready. The bots tolerate a not-yet-ready api (they retry their first calls), so gating on `service_started` avoids a deadlock if the api healthcheck is slow; Redis (which the bots connect to immediately) is gated on `service_healthy`.

- [ ] **Step 2: Validate the compose file parses**

Run: `docker compose config --quiet && echo OK`
Expected output: `OK` (no parse/interpolation errors). Requires a `.env` present in the repo root (use `.env.example` copied to `.env` for local validation).

- [ ] **Step 3: Confirm all five services are declared**

Run: `docker compose config --services | sort`
Expected output (exactly five lines):
```
api
discord-bot
postgres
redis
telegram-bot
```

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "chore(deploy): consolidate authoritative 5-service docker-compose"
```

---

## Task 2: Fold the admin SPA build into the api image

**Files:**
- Modify: `packages/api/Dockerfile`

Spec §6: the admin React SPA is built in `packages/admin` and its output copied into `packages/api/public/admin/`, served by Express at `/admin/*` — one image, one process. Plan 1's api `Dockerfile` builds only `shared` + `api`. This task adds the `admin` workspace to the build stage so `packages/api/public/admin/` exists in the runtime image. (Plan 5 produces the `packages/admin` package and the Express static-serving of `public/admin`; this task wires its build artifact into the api image.)

- [ ] **Step 1: Replace `packages/api/Dockerfile` with the admin-aware multi-stage build**

```dockerfile
# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/admin/package.json packages/admin/
COPY packages/api/package.json packages/api/
RUN npm ci
COPY packages/shared packages/shared
COPY packages/admin packages/admin
COPY packages/api packages/api
RUN npx prisma generate --schema packages/api/prisma/schema.prisma
RUN npm run build -w @debates/shared \
 && npm run build -w @debates/admin \
 && npm run build -w @debates/api
# The admin build (Plan 5) emits its bundle into packages/api/public/admin/.

# Runtime stage
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
RUN npm ci --omit=dev
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/api/dist packages/api/dist
COPY --from=build /app/packages/api/prisma packages/api/prisma
COPY --from=build /app/packages/api/public packages/api/public
COPY --from=build /app/node_modules/.prisma node_modules/.prisma
EXPOSE 3000
CMD ["sh", "-c", "npm run prisma:migrate -w @debates/api && npm run start -w @debates/api"]
```

> **What changed from Plan 1's Dockerfile:** (1) the build stage now also copies and builds the `@debates/admin` workspace, and (2) the runtime stage copies `packages/api/public` (which contains `admin/` after the admin build) into the image. The `CMD` is unchanged: it still runs `prisma migrate deploy` then starts the api. Migrations therefore run automatically on every container start — see Task 6 for the deploy-ordering note.

- [ ] **Step 2: Build the api image to confirm the admin bundle lands**

Run: `docker compose build api`
Expected: build succeeds. Then verify the SPA is present in the image:

Run: `docker compose run --rm --no-deps --entrypoint sh api -c "ls packages/api/public/admin/index.html"`
Expected output: `packages/api/public/admin/index.html` (the file exists — the admin build was folded in).

- [ ] **Step 3: Commit**

```bash
git add packages/api/Dockerfile
git commit -m "chore(deploy): build admin SPA into the api image"
```

---

## Task 3: Host nginx site — TLS termination + reverse proxy

**Files:**
- Create: `deploy/nginx.conf`

nginx runs on the host, terminates TLS for `debates.animeenigma.com`, redirects HTTP→HTTPS, and proxies **all** of `/` to `127.0.0.1:3000`. Express does the internal routing (`/admin/*`, `/api/*`, `/healthz`). No WebSocket upgrade headers are needed (the design has no real-time connections). `client_max_body_size` is raised so session `.zip` downloads stream without nginx capping the response (downloads are served by Express, but raising the limit also avoids surprises on any future admin upload).

- [ ] **Step 1: Create `deploy/nginx.conf`**

```nginx
# deploy/nginx.conf — host nginx site for debates.animeenigma.com
# Install to /etc/nginx/sites-available/debates.animeenigma.com and symlink into
# sites-enabled (see deploy/README.md). certbot --nginx manages the cert paths.

# HTTP: redirect everything to HTTPS (certbot's ACME http-01 challenge under
# /.well-known/acme-challenge/ is served before this redirect by certbot's own
# temporary config during issuance/renewal).
server {
    listen 80;
    listen [::]:80;
    server_name debates.animeenigma.com;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS: terminate TLS, proxy all paths to the api container on loopback.
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name debates.animeenigma.com;

    ssl_certificate     /etc/letsencrypt/live/debates.animeenigma.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/debates.animeenigma.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    # Session .zip / .ogg downloads can be large; do not let nginx cap them.
    client_max_body_size 512m;

    # Long-lived streaming responses (zip of a multi-hour session).
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
    }
}
```

> **No `Upgrade`/`Connection` upgrade headers:** the system has no WebSocket or SSE endpoints (spec §1 explicitly removed the WebSocket protocol), so the proxy block deliberately omits them.

- [ ] **Step 2: Validate the syntax on the host** — **run on host `ZenithOfVastness`** (after the file is installed per the README and the cert exists)

Run: `sudo nginx -t`
Expected output: `nginx: configuration file /etc/nginx/nginx.conf test is successful` (`syntax is ok` + `test is successful`).

> Until the Let's Encrypt cert exists, `nginx -t` fails on the missing `ssl_certificate` file — that is expected; obtain the cert first (Task 5 / README step), then re-run.

- [ ] **Step 3: Commit**

```bash
git add deploy/nginx.conf
git commit -m "feat(deploy): host nginx TLS reverse proxy for debates.animeenigma.com"
```

---

## Task 4: Nightly Postgres backup script + rotation

**Files:**
- Create: `deploy/backup.sh`

Spec §9 backups: nightly `pg_dump` to `/data/tooronkaich/backups/`, keep the last 14. The dump runs **inside** the `postgres` container via `docker compose exec` so it uses the container's `pg_dump` and the in-network credentials from `.env`. Recordings and Redis AOF are **not** backed up (see the header comment for why).

- [ ] **Step 1: Create `deploy/backup.sh`**

```bash
#!/usr/bin/env bash
# deploy/backup.sh — nightly Postgres backup for the debates stack.
#
# Backs up ONLY Postgres. Deliberately NOT backed up:
#   * recordings  — ephemeral, auto-deleted after 30 days by the api's
#                   cleanup_old_recordings cron (spec §9 / §4). If a recording
#                   matters long-term, the admin downloads it from the panel.
#   * Redis AOF   — the game-events jobs are fully derived from games.scheduled_at;
#                   the api's boot-time + hourly reconcileJobs (Plan 2) re-enqueues
#                   any missing jobs, so a lost Redis volume self-heals on next boot.
#
# Run nightly from the host crontab (see deploy/README.md). Keeps the last 14 dumps.
set -euo pipefail

PROJECT_DIR="/data/tooronkaich"
BACKUP_DIR="${PROJECT_DIR}/backups"
KEEP=14
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
OUTFILE="${BACKUP_DIR}/debates_${TIMESTAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

# Load POSTGRES_USER / POSTGRES_DB from the deployment .env.
set -a
# shellcheck disable=SC1091
. "${PROJECT_DIR}/.env"
set +a

cd "${PROJECT_DIR}"

# Dump inside the postgres container, gzip on the host. pg_dump exits non-zero on
# failure; set -o pipefail + the trap below ensure a failed dump leaves no
# truncated file masquerading as a good backup.
trap 'rm -f "${OUTFILE}"; echo "[backup] FAILED at ${TIMESTAMP}" >&2' ERR

docker compose exec -T postgres \
  pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" --no-owner --clean --if-exists \
  | gzip -9 > "${OUTFILE}"

trap - ERR

# Rotate: keep the newest ${KEEP} dumps, delete the rest.
ls -1t "${BACKUP_DIR}"/debates_*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "[backup] wrote ${OUTFILE} ($(du -h "${OUTFILE}" | cut -f1)); kept last ${KEEP}."
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x deploy/backup.sh`
Expected: no output; `ls -l deploy/backup.sh` shows the `x` bit.

- [ ] **Step 3: Lint the script for shell errors**

Run: `bash -n deploy/backup.sh && echo "syntax ok"`
Expected output: `syntax ok`. (If `shellcheck` is available: `shellcheck deploy/backup.sh` → no errors.)

- [ ] **Step 4: Dry-run on the host once the stack is up** — **run on host `ZenithOfVastness`**

Run: `/data/tooronkaich/deploy/backup.sh`
Expected output: `[backup] wrote /data/tooronkaich/backups/debates_<ts>.sql.gz (<size>); kept last 14.` and the file exists and is non-empty:

Run: `ls -lh /data/tooronkaich/backups/`
Expected: at least one `debates_*.sql.gz` of non-trivial size; `gzip -t` on it passes.

- [ ] **Step 5: Install the host crontab line** — **run on host `ZenithOfVastness`**

Add to root's crontab (`sudo crontab -e`) — nightly at 03:17 UTC (off the :00 mark):
```cron
17 3 * * * /data/tooronkaich/deploy/backup.sh >> /data/tooronkaich/backups/backup.log 2>&1
```
Verify it is registered:

Run: `sudo crontab -l | grep backup.sh`
Expected: prints the line above.

- [ ] **Step 6: Commit**

```bash
git add deploy/backup.sh
git commit -m "feat(deploy): nightly pg_dump backup with 14-day rotation"
```

---

## Task 5: TLS certificate issuance + auto-renewal

**Files:** (host-only; no repo files — documented here and in the README)

certbot obtains and renews the Let's Encrypt cert for `debates.animeenigma.com`. The nginx plugin installs the cert and reloads nginx automatically; the renewal runs from certbot's packaged systemd timer (or cron), with an nginx reload deploy-hook.

- [ ] **Step 1: Obtain the certificate** — **run on host `ZenithOfVastness`**

DNS for `debates.animeenigma.com` must already point at the VPS and ports 80/443 must be open. Then:

Run: `sudo certbot --nginx -d debates.animeenigma.com --redirect -m 0neymik0@gmail.com --agree-tos --no-eff-email`
Expected: `Successfully received certificate.` and files exist under `/etc/letsencrypt/live/debates.animeenigma.com/` (`fullchain.pem`, `privkey.pem`). certbot edits the enabled site to wire the cert; because `deploy/nginx.conf` already references those exact paths, re-running `sudo nginx -t` now succeeds.

> **Webroot alternative** (if you prefer not to let certbot edit nginx): `sudo certbot certonly --webroot -w /var/www/html -d debates.animeenigma.com -m 0neymik0@gmail.com --agree-tos`. The HTTP server block in `deploy/nginx.conf` already serves `/.well-known/acme-challenge/` from `/var/www/html` for this path.

- [ ] **Step 2: Confirm the renewal timer is active** — **run on host `ZenithOfVastness`**

Run: `sudo systemctl list-timers | grep certbot`
Expected: a `certbot.timer` line with a future `NEXT` run. (On distros without the timer, certbot installs `/etc/cron.d/certbot` instead — `cat /etc/cron.d/certbot` shows the twice-daily renew line.)

- [ ] **Step 3: Add an nginx reload deploy-hook so renewed certs are picked up** — **run on host `ZenithOfVastness`**

Run: `echo -e '#!/bin/sh\nnginx -s reload' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh && sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh`
Expected: the hook file is written and executable.

- [ ] **Step 4: Dry-run a renewal** — **run on host `ZenithOfVastness`**

Run: `sudo certbot renew --dry-run`
Expected: `Congratulations, all simulations of the renewals succeeded` (the deploy-hook runs `nginx -s reload` without error).

> No repo commit for this task — it is entirely host configuration. The steps are mirrored in `deploy/README.md` (Task 7).

---

## Task 6: Deploy / update procedure

**Files:** (host-only operational procedure; documented in `deploy/README.md` Task 7 — captured here as the canonical sequence)

The update flow on the host is: pull, rebuild, bring up, ensure migrations are applied. Because the api container's `CMD` already runs `prisma migrate deploy` on **every** start (Plan 1 Dockerfile, unchanged in Task 2), bringing the stack up with `--build` is sufficient to apply migrations. The explicit `exec` migrate command below is an idempotent belt-and-suspenders confirmation — running `migrate deploy` a second time is a no-op when there is nothing pending.

- [ ] **Step 1: The canonical update sequence** — **run on host `ZenithOfVastness`**, from `/data/tooronkaich`

```bash
cd /data/tooronkaich
git pull
docker compose up -d --build
# Migrations already ran during the api container start above (CMD: prisma migrate
# deploy && start). This explicit call is an idempotent confirmation — it prints
# "No pending migrations" when the startup run already applied them.
docker compose exec api npm run prisma:migrate -w @debates/api
```

Expected for the final command: `No pending migrations to apply.` on a normal redeploy (or the list of freshly-applied migrations if `git pull` introduced new ones and you raced the startup run — either way the DB ends up migrated exactly once, because `migrate deploy` is idempotent).

> **Ordering clarification (so it is not surprising):** the api `Dockerfile` `CMD` is `prisma migrate deploy && start`. On `docker compose up -d --build`, the new api container runs migrations *before* it begins listening. The `docker compose exec ... prisma:migrate` line therefore almost always reports nothing pending. We keep it in the runbook as an explicit verification gate, not because migrations would otherwise be skipped.

- [ ] **Step 2: Confirm all five containers are healthy after an update** — **run on host `ZenithOfVastness`**

Run: `docker compose ps`
Expected: `postgres`, `redis`, `api`, `discord-bot`, `telegram-bot` all `Up` (postgres/redis `healthy`).

> No repo commit — the procedure lives in `deploy/README.md` (Task 7).

---

## Task 7: VPS bootstrap runbook (`deploy/README.md`)

**Files:**
- Create: `deploy/README.md`

A one-page, copy-pasteable runbook to take a fresh Ubuntu VPS to a running, public deployment. Every command is concrete.

- [ ] **Step 1: Create `deploy/README.md`**

````markdown
# Debates Helper — VPS Deployment Runbook

Single-VPS deployment. Host: **`ZenithOfVastness`** (`ssh ZenithOfVastness`).
Project path: **`/data/tooronkaich/`**. Public domain: **`debates.animeenigma.com`**.
Minimum VPS: **2 vCPU / 4 GB RAM / 50 GB SSD** (Whisper in Phase 1.1 will need more).

All commands below run on the host as a sudo-capable user unless noted.

---

## 1. Install Docker + compose plugin (Ubuntu 22.04+)

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo docker compose version   # confirm the compose plugin is present
```

## 2. Install nginx + certbot

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

## 3. Clone the repo to /data/tooronkaich

```bash
sudo mkdir -p /data/tooronkaich
sudo chown "$USER":"$USER" /data/tooronkaich
git clone <REPO_URL> /data/tooronkaich
cd /data/tooronkaich
```

## 4. Create the recordings + backups host dirs (bind-mount targets)

```bash
mkdir -p /data/tooronkaich/recordings
mkdir -p /data/tooronkaich/backups
```

## 5. Write .env and fill secrets

```bash
cp .env.example .env
```

Generate the three 32-byte secrets and paste them into `.env`:

```bash
openssl rand -hex 32   # -> JWT_SECRET
openssl rand -hex 32   # -> DISCORD_BOT_API_TOKEN
openssl rand -hex 32   # -> TELEGRAM_BOT_API_TOKEN
```

Also set a strong `POSTGRES_PASSWORD` (and update `DATABASE_URL` to match), and fill
the platform secrets: `DISCORD_BOT_TOKEN` (Developer Portal → Bot), `TELEGRAM_BOT_TOKEN`
(@BotFather), `DISCORD_GUILD_ID` (your debate server's id). Confirm the pre-filled
values are right for this deployment:

```
PUBLIC_URL=https://debates.animeenigma.com
ADMIN_TELEGRAM_IDS=898912046
DISCORD_CLIENT_ID=1511558875571159201
DEBATE_ANNOUNCE_CHANNEL_ID=607662041561563167
DEBATE_FALLBACK_CHANNEL_ID=607662041561563167
TELEGRAM_BOT_USERNAME=tooronkaich_bot
```

> `.env` is git-ignored — never commit it.

## 6. Install the nginx site (before TLS, the HTTPS block won't validate yet)

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/debates.animeenigma.com
sudo ln -sf /etc/nginx/sites-available/debates.animeenigma.com /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
```

## 7. Obtain the TLS cert (DNS must already point here; ports 80/443 open)

```bash
sudo certbot --nginx -d debates.animeenigma.com --redirect \
  -m 0neymik0@gmail.com --agree-tos --no-eff-email
sudo nginx -t && sudo systemctl reload nginx
```

Add the renewal reload hook and verify auto-renewal:

```bash
echo -e '#!/bin/sh\nnginx -s reload' \
  | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo certbot renew --dry-run
```

## 8. Build and start the stack

```bash
cd /data/tooronkaich
docker compose up -d --build
docker compose ps        # all 5 services Up (postgres/redis healthy)
```

The api container runs `prisma migrate deploy` automatically on start.

## 9. Verify health through the public domain

```bash
curl https://debates.animeenigma.com/healthz
# -> {"status":"ok"}
```

## 10. Register the Discord bot invite

Open this invite URL (permissions bitfield `36768768`, scopes `bot applications.commands`)
and add the bot to the debate server:

```
https://discord.com/oauth2/authorize?client_id=1511558875571159201&permissions=36768768&scope=bot%20applications.commands
```

Slash commands (`/link`, `/record`) are registered guild-scoped at bot startup for the
`DISCORD_GUILD_ID` you set in `.env`.

## 11. Set the Telegram Login Widget domain (REQUIRED for admin login)

In Telegram, message **@BotFather**:

```
/setdomain
<choose @tooronkaich_bot>
debates.animeenigma.com
```

> This is **mandatory** — the admin web login (spec §8) uses the Telegram Login Widget,
> which Telegram only renders for the exact domain registered here. Without it, the
> "Log in with Telegram" button does nothing and no admin can sign in.

## 12. Pin the consent notice in the voice channel (spec §11 — required)

In the debates voice channel(s), post and **pin** this notice:

> By joining voice during a scheduled debate, you consent to being recorded for
> personal feedback purposes. Recordings are retained for 30 days then deleted
> automatically. Contact the admin to opt out.

This is an operational requirement, not a suggestion.

## 13. Backups

The nightly Postgres backup is `deploy/backup.sh`. Install the host crontab line:

```bash
sudo crontab -e
# add:
17 3 * * * /data/tooronkaich/deploy/backup.sh >> /data/tooronkaich/backups/backup.log 2>&1
```

Recordings (ephemeral, 30-day retention) and Redis AOF (self-heals via the api's
`reconcileJobs`) are intentionally **not** backed up — see the header of `backup.sh`.

## 14. Updating the deployment

```bash
cd /data/tooronkaich
git pull
docker compose up -d --build
docker compose exec api npm run prisma:migrate -w @debates/api   # idempotent confirm
docker compose ps
```

Migrations also run automatically on api container start; the explicit `prisma:migrate`
above normally reports "No pending migrations" and exists as a verification gate.
````

- [ ] **Step 2: Confirm the runbook references real repo paths**

Run: `grep -c "deploy/nginx.conf\|deploy/backup.sh\|/data/tooronkaich\|debates.animeenigma.com" deploy/README.md`
Expected: a non-zero count (the runbook references the committed files and the spec §9 host/domain).

- [ ] **Step 3: Commit**

```bash
git add deploy/README.md
git commit -m "docs(deploy): one-page VPS bootstrap runbook"
```

---

## Task 8: End-to-end smoke-test checklist

**Files:** (operational checklist — no repo files; record results in the PR / ops log)

Run after a fresh deploy (or any update) on the host to confirm the full loop. **Run on host `ZenithOfVastness`** unless a step is a browser/Discord/Telegram action.

- [ ] **Step 1: Health endpoint through nginx + TLS**

Run: `curl -s https://debates.animeenigma.com/healthz`
Expected output: `{"status":"ok"}`

- [ ] **Step 2: All five containers up**

Run: `docker compose ps`
Expected: `postgres`, `redis`, `api`, `discord-bot`, `telegram-bot` all `Up`; postgres + redis `healthy`.

- [ ] **Step 3: Admin SPA loads + admin login**

In a browser, open `https://debates.animeenigma.com/admin/login`.
Expected: the SPA loads; the "Log in with Telegram" widget renders (proves Task 11 BotFather `/setdomain` is correct). Click it, authorize with the admin Telegram account (id in `ADMIN_TELEGRAM_IDS`).
Expected: redirected into `/admin/games` with a session cookie set (a non-admin Telegram id is rejected with 403).

Backend confirmation:

Run: `curl -s -i https://debates.animeenigma.com/api/admin/me`
Expected without a cookie: `401` `{"error":"unauthorized"}` (the protected endpoint is wired).

- [ ] **Step 4: Create a game via the admin UI**

In `/admin/games/new`: pick a time a few minutes out, optional motion, select at least one participant, submit.
Expected: redirect to the game detail page; the notification timeline is shown. Confirm in the DB:

Run: `docker compose exec postgres psql -U debates -d debates -c "select id, status, motion from games order by created_at desc limit 1;"`
Expected: one `scheduled` row with your motion.

- [ ] **Step 5: `/link` round-trip (Telegram → Discord)**

In Telegram, `/start` then `/code` with the bot to receive a `LINK-XXXX` code. In the
Discord server, run `/link LINK-XXXX`.
Expected: Discord replies that the account is linked. Confirm:

Run: `docker compose exec postgres psql -U debates -d debates -c "select telegram_user_id, discord_user_id, display_name from users where discord_user_id is not null order by updated_at desc limit 1;"`
Expected: a row with both `telegram_user_id` and `discord_user_id` populated.

- [ ] **Step 6: `/record start` → `/record stop` produce files in the bind dir**

Join a voice channel, run `/record start`.
Expected: the bot posts the consent notice with a session id and starts recording; speak for a few seconds. The DB shows an active session:

Run: `docker compose exec postgres psql -U debates -d debates -c "select id, status, voice_channel_name from recording_sessions order by started_at desc limit 1;"`
Expected: one `recording` row.

Run `/record stop`.
Expected: the bot replies with speaker count + duration. Files are on the host bind-mount:

Run: `ls -R /data/tooronkaich/recordings/ | tail -n 20`
Expected: a session directory containing `<user>_<last4>.ogg` file(s) and `_metadata.json`. The session row is now `completed`:

Run: `docker compose exec postgres psql -U debates -d debates -c "select status, ended_at from recording_sessions order by started_at desc limit 1;"`
Expected: `completed` with a non-null `ended_at`.

- [ ] **Step 7: Concurrency guard (per-guild 409)**

With a recording active, run `/record start` again in the same server.
Expected: the bot replies *"a recording is already active in this server."* (the API's partial-unique-index 409 surfaced).

- [ ] **Step 8: Download a recording from the admin panel**

In `/admin/recordings/:id`, click a per-speaker download and "Download all as .zip".
Expected: a playable `.ogg` downloads and the `.zip` contains the `.ogg` files + `_metadata.json`.

> If all eight steps pass, the deployment is live and the phase-1 loop works end to end.

---

## Self-review against the spec

**Spec §9 (Deployment):**
- **Host `ZenithOfVastness`** — named throughout; runbook is written for it (Task 7). ✓
- **Project path `/data/tooronkaich/`** — clone target, bind-mount source, backup dir, all use it (Tasks 1, 4, 7). ✓
- **Domain `debates.animeenigma.com`** — nginx `server_name`, cert, `PUBLIC_URL`, health check (Tasks 3, 5, 7, 8). ✓
- **Reverse proxy: nginx on host terminates TLS, proxies all `/` to api:3000; Express routes `/admin/*` + `/api/*` internally** — `deploy/nginx.conf` proxies `location /` to `127.0.0.1:3000` with no internal path-splitting (Task 3). ✓
- **Minimum VPS 2 vCPU / 4 GB / 50 GB** — stated in the runbook (Task 7). ✓
- **docker-compose (all five services)** — consolidated authoritative file with `postgres`, `redis`, `api`, `discord-bot`, `telegram-bot` (Task 1). ✓
- **Env vars** — `.env` from `.env.example`, `openssl rand -hex 32` for the three secrets, `env_file: .env` on app services (Tasks 1, 7). ✓
- **Storage paths** — `recordings` bind-mounted to `/data/tooronkaich/recordings/` in both api + discord-bot; pgdata/redisdata named volumes (Task 1); backups to `/data/tooronkaich/backups/` (Task 4). ✓
- **Backups** — nightly `pg_dump` + 14-day rotation + crontab; recordings/Redis explicitly not backed up with the reconcile reasoning referenced (Task 4, header comment cites Plan 2 `reconcileJobs`). ✓

**Spec §10 (Discord setup):**
- **Invite URL** — exact bitfield `36768768`, scopes `bot applications.commands`, client id `1511558875571159201` (Task 7 step 10). ✓
- **BotFather `/setdomain`** — called out as REQUIRED for the §8 admin Login Widget (Task 7 step 11, and verified in the smoke test step 3). ✓

**Spec §11 (Consent):**
- **Pinned consent notice in the voice channel** — exact wording in the runbook, marked an operational requirement (Task 7 step 12). The on-`/record start` notice is the discord-bot's job (Plan 3); this plan covers the pinned channel notice. ✓

**Cross-plan consolidation consistency:**
- Service names match those referenced in Plans 1–5: `postgres`, `redis`, `api`, `discord-bot`, `telegram-bot`. ✓
- `recordings` mount path `/var/lib/debates/recordings` matches Plan 1/3 `RECORDINGS_DIR` and `discord-bot` config default; both `api` and `discord-bot` mount the same host path (shared-volume contract preserved). ✓
- `API_BASE_URL=http://api:3000` and `REDIS_URL=redis://redis:6379` match the Plan 3/4 bot configs. ✓
- `NODE_ENV=production` set on api/discord-bot/telegram-bot, making the Plan 2 `requireAdmin` `x-test-admin-id` bypass unreachable. ✓
- Telegram-bot service (Plan 4, not yet authored) is included per spec §2/§9: depends on api + redis, `env_file: .env`, no volumes — matching the discord/telegram split (discord owns `announce_t30`, telegram owns the rest). The telegram-bot `Dockerfile` path `packages/telegram-bot/Dockerfile` is assumed to follow the Plan 1 api / Plan 3 discord-bot multi-stage pattern; if Plan 4 names it differently, update the `dockerfile:` line in Task 1. ⚠ (flagged)
- Admin SPA folded into the api image (Task 2) per spec §6 — no separate admin container, single process serves `/admin/*` + `/api/*`. The `packages/admin` build emitting into `packages/api/public/admin/` is a Plan 5 contract; Task 2's build step depends on it. ⚠ (flagged dependency)

**Placeholder scan:** every file (`docker-compose.yml`, `nginx.conf`, `backup.sh`, `README.md`) is shown in full with concrete values and commands; no "configure as needed" / TBD / TODO. The only two `⚠` items above are cross-plan contracts (telegram-bot Dockerfile name from Plan 4, admin build output from Plan 5), not placeholders in this plan's deliverables. ✓

---

**End of Plan 6 — and the plan series.** With Plans 1–5 implementing the monorepo, API domain, Discord bot, Telegram bot, and web admin, this plan makes the system publicly deployable on `ZenithOfVastness`: one `docker compose up -d --build` behind host nginx + Let's Encrypt TLS, nightly Postgres backups, automatic cert renewal, and a verified end-to-end smoke test of the phase-1 loop (schedule → notify → link → record → download).
