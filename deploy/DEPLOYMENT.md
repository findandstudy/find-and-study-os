# Find And Study OS — Controlled Release Guide

This runbook never copies or rolls back the database, runtime environment or
storage. Production actions require an approved preflight and fresh backup.

## Table of Contents

1. [VPS Requirements](#vps-requirements)
2. [Initial Server Setup](#initial-server-setup)
3. [PostgreSQL Setup](#postgresql-setup)
4. [Node.js Installation](#nodejs-installation)
5. [Project Setup](#project-setup)
6. [Non-root Runtime Boundary](#non-root-runtime-boundary)
7. [Environment Configuration](#environment-configuration)
8. [First Deploy](#first-deploy)
9. [Nginx Setup](#nginx-setup)
10. [SSL with Let's Encrypt](#ssl-with-lets-encrypt)
11. [PM2 Auto-Start & Log Rotation](#pm2-auto-start--log-rotation)
12. [Zero-Downtime Updates](#zero-downtime-updates)
13. [Database Migrations](#database-migrations)
14. [Public Endpoints (Anonim Yüzey)](#public-endpoints-anonim-yüzey)
15. [Rollback](#rollback)
16. [Monitoring](#monitoring)
17. [Troubleshooting](#troubleshooting)

---

## VPS Requirements

- **OS**: Ubuntu 22.04+ or Debian 12+
- **RAM**: Minimum 2 GB (4 GB recommended)
- **CPU**: 2+ cores
- **Disk**: 20 GB+ SSD
- **Software**: Node.js 20+, PostgreSQL 16, Nginx, PM2

---

## Initial Server Setup

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential tools
sudo apt install -y curl git build-essential ufw

# Configure firewall
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

---

## PostgreSQL Setup

```bash
# Install PostgreSQL 16
sudo apt install -y postgresql postgresql-contrib

# Start and enable
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Veritabanı ve kullanıcı oluşturun
sudo -u postgres psql <<EOF
CREATE USER edconsult WITH PASSWORD 'guclu-bir-sifre-girin';
CREATE DATABASE edconsult_db OWNER edconsult;
GRANT ALL PRIVILEGES ON DATABASE edconsult_db TO edconsult;
\c edconsult_db
GRANT ALL ON SCHEMA public TO edconsult;
EOF
```

`DATABASE_URL` değeriniz:

```
postgresql://edconsult:guclu-bir-sifre-girin@localhost:5432/edconsult_db
```

---

## Node.js Installation

```bash
# Install Node.js 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install pnpm globally
npm install -g pnpm

# Install PM2 globally
npm install -g pm2

# Verify versions
node --version    # v20.x.x
pnpm --version
pm2 --version
```

---

## Project Setup

```bash
# One-time setup only, after an approved non-root migration change window.
sudo useradd --system --create-home --home-dir /var/lib/findandstudy \
  --shell /usr/sbin/nologin findandstudy
sudo install -d -o findandstudy -g findandstudy -m 0750 \
  /opt/findandstudy/source /opt/findandstudy/releases /var/log/findandstudy
sudo install -d -o findandstudy -g findandstudy -m 0700 \
  /var/lib/findandstudy/storage /var/lib/findandstudy/storage/private

# Projeyi klonlayın veya yükleyin
sudo -u findandstudy git clone https://your-repo-url.git /opt/findandstudy/source

# Install dependencies
sudo -u findandstudy pnpm --dir /opt/findandstudy/source install --frozen-lockfile
```

---

## Non-root Runtime Boundary

`deploy/deploy.sh` now fails before creating a release, installing dependencies
or touching a process unless all of these statements are true:

- the operator is the explicit `RUNTIME_SERVICE_USER`, never `root`;
- release, log and local-storage roots are owned by that service uid/gid and
  grant no access to unrelated VPS users;
- `RUNTIME_ENV_FILE` is either service-owned `0600` or root:service `0640`;
- every private object and directory is service-owned, user-only (`0600` files,
  `0700` directories), non-executable and not a symbolic link;
- the bounded private-tree scan completes before the configured entry and
  duration limits.

`RUNTIME_PRIVATE_SCAN_MAX_ENTRIES` may lower the scan budget but must be a
canonical positive integer and can never raise the hard `100000`-entry ceiling.
`RUNTIME_PRIVATE_SCAN_MAX_DURATION_MS` follows the same canonical format and may
lower, but never raise, the hard `30000`-millisecond ceiling. Scientific
notation, decimals, leading zeros and larger values fail closed. Directory
entries are streamed and counted before queueing, so one very large directory
cannot first materialize an unbounded filename list in memory. Both the
deployment preflight and read-only production attestation enforce these same
private-tree ceilings.

Source provenance and process metadata remain exact read-only probes. Each
`git rev-parse`, `git status` and `ps` child process has a fixed
`10000`-millisecond `SIGKILL` timeout that cannot be raised by environment
configuration; a timeout blocks attestation instead of producing partial
evidence. The localhost health response is streamed under a fixed `65536`-byte
ceiling before JSON parsing; the limit cannot be raised by environment
configuration and an oversized body blocks the attestation. Its target is an
exact canonical port on `127.0.0.1`; redirects and a changed response URL are
rejected, so the probe cannot follow a local redirect to another host. Only an
exact HTTP `200` response with the `application/json` media type is admitted.
Each selected process is also revalidated against its `/proc` directory
uid/gid and kernel start-time identity before and after resolving its cwd. PID
reuse, process replacement, uid/gid drift, `/proc` inode replacement or cwd
change blocks the attestation. Process arguments are not added to the emitted
evidence.

This is a deployment gate, not an automatic migration. The current production
host was last observed with root-owned `0644/0755` private storage and root-owned
PM2 processes. Do not merge and deploy this boundary until an approved change
plan has captured a fresh DB/storage backup, exact ownership inventory, disk
headroom, two-session recovery access, PM2 startup ownership and a rollback
path. Do not run recursive `chown`/`chmod`, stop root PM2 or change SSH policy as
part of an ordinary application release.

The safe transition sequence is:

1. Read-only inventory and backup verification.
2. Create and verify the dedicated account and its recovery path.
3. Copy no data; change only the exact reviewed runtime roots and private tree.
4. Start one candidate API as the service account with background jobs disabled.
5. Prove HTTP/DB readiness, storage read/write and portal-worker ownership.
6. Cut over the canonical PM2 processes once, then verify reboot persistence.
7. Keep the previous code release and recorded ownership manifest for rollback.
8. Harden root/password SSH only in a later, separately approved change.

No environment flag bypasses this boundary. A failed preflight is a NO-GO.

The deploy also stops before release creation or build unless every relevant
filesystem has both at least `15 GiB` and at least `15%` space available to the
non-root runtime account. `RELEASES_DIR`, `LOG_DIR` and, for local storage,
`STORAGE_LOCAL_DIR` are checked with filesystem metadata only. These are hard
minimums with no environment bypass. Freeing space requires a separately
reviewed attribution/retention plan; the deploy never deletes releases, logs,
backups or private objects automatically.

Before planning the production transition, collect a metadata-only attestation
from a separate, clean source checkout at the exact reviewed 40-character
commit. The source checkout is evidence tooling, not the deployed release. The
tool independently verifies the live `CURRENT_RELEASE_LINK`, process working
directories and health release identity. It opens the database transaction as
`READ ONLY`, verifies the Drizzle ledger against the reviewed source hashes,
calls only the localhost health `GET`, reads process/path/filesystem metadata
and emits no private filenames, file contents, environment values or database
credentials:

```bash
cd /opt/findandstudy/source
reviewed_commit="<approved-40-character-commit>"
expected_release_id="<approved-live-release-directory-name>"
expected_applied_migrations="<approved-production-prefix-count>"
expected_database_name="<approved-production-database-name>"
expected_database_address="<approved-server-ip-as-seen-by-postgresql>"
expected_database_port="<approved-postgresql-port>"
test "$(git rev-parse --verify HEAD)" = "$reviewed_commit"
test -z "$(git status --porcelain=v1 --untracked-files=normal)"
export RUNTIME_ENV_FILE=/etc/findandstudy.env
set -a
# shellcheck disable=SC1091
source "$RUNTIME_ENV_FILE"
set +a
umask 077
attestation_file="$(mktemp /tmp/fasos-attestation.XXXXXX.json)"
ATTESTATION_EXPECTED_SOURCE_COMMIT="$reviewed_commit" \
  ATTESTATION_EXPECTED_RELEASE_ID="$expected_release_id" \
  ATTESTATION_EXPECTED_APPLIED_MIGRATIONS="$expected_applied_migrations" \
  ATTESTATION_EXPECTED_DATABASE_NAME="$expected_database_name" \
  ATTESTATION_EXPECTED_DATABASE_ADDRESS="$expected_database_address" \
  ATTESTATION_EXPECTED_DATABASE_PORT="$expected_database_port" \
  PRODUCTION_ATTESTATION_READ_ONLY=1 \
  node deploy/production-readonly-attestation.mjs > "$attestation_file"
printf 'Attestation written to %s\n' "$attestation_file"
```

Disk attribution is optional and remains part of the same exact-source,
exact-release and exact-database read-only attestation. Enable it only after the
fixed category roots and I/O budget have been reviewed:

```bash
export ATTESTATION_INCLUDE_DISK_ATTRIBUTION=1
export DISK_ATTRIBUTION_MAX_ENTRIES=20000
export DISK_ATTRIBUTION_MAX_DURATION_MS=5000

# Optional categories; use only reviewed, existing, narrow absolute roots.
# export DISK_ATTRIBUTION_DATABASE_DIR=/var/lib/postgresql/16/main
# export DISK_ATTRIBUTION_BACKUP_DIR=/var/backups/findandstudy
```

The entry and duration values are mandatory when attribution is enabled. They
cannot exceed the hard `100000`-entry and `30000ms` ceilings. Releases, logs and
local storage are fixed categories; database and backup roots are optional.
Roots must be at least three path segments deep, may not overlap and may not
cross a filesystem boundary. Directory entries are streamed, symlinks are not
followed, and the result contains only category counts and logical/allocated
byte totals—never filenames or contents. `filesystemTotalBytes` and
`filesystemAvailableBytes` describe the containing filesystem and can repeat
when categories share a filesystem; do not sum those capacity fields. Any
budget, path, mount or read error fails the attribution instead of returning an
apparently complete partial result. This tool never deletes or rotates data and
does not itself approve a retention action.

Preparing or updating `/opt/findandstudy/source` is a separate, explicitly
reviewed source-only operation; it is not a deploy and must not change the
`current` symlink or any process. Use a frozen dependency install matching the
reviewed lockfile. Never run the attestation from an ambiguous or dirty source
tree. Review the JSON before moving it off-host. The command is evidence
collection, not approval to deploy or change ownership. A source-commit or
cleanliness mismatch, unexpected release identity, applied migration count
other than the explicitly approved prefix, database name/server IP/port drift,
ledger hash mismatch, `CURRENT_RELEASE_LINK` symlink/target replacement during
the measurement, duplicate API or worker, missing path, unreachable local
health endpoint or exceeded private-tree limit fails closed. For the current
convergence decision, the reviewed expectation is the separately verified live
release identity, `fasos_apply`, the approved local PostgreSQL IP/port and
exactly `66` applied production-prefix migrations; do not copy these values
from an unreviewed host observation or use a DNS alias.

---

## Environment Configuration

```bash
# Runtime secrets are external to source and every release. The service account
# can read the file through its exact group but cannot modify it.
sudo install -o root -g findandstudy -m 0640 /dev/null /etc/findandstudy.env
sudo nano /etc/findandstudy.env
```

> **deploy/.env.example** tüm desteklenen değişkenleri ve açıklamalarını içerir.

**Zorunlu değişkenler (`<degistir>` ile işaretli):**

- `DATABASE_URL` — PostgreSQL bağlantı dizisi
- `PORT` — `5000` (nginx.conf upstream ile eşleşmeli)
- `RUNTIME_SERVICE_USER` — dedicated non-root Unix account (`findandstudy`)
- `SESSION_SECRET` — Üret: `openssl rand -hex 32`
- `ENCRYPTION_KEY` — Üret: `openssl rand -hex 32`
- `EMBED_TOKEN_SECRET` — Üret: `openssl rand -hex 32`
- `ALLOWED_ORIGINS` — Domain'leriniz, örn. `https://yourdomain.com`
- `APP_BASE_URL` — Uygulamanın dış URL'i (e-posta/PDF linklerinde kullanılır)
- `WA_ACCESS_TOKEN` — WhatsApp entegrasyonu için (istege bağlı ama önerilir)
- `WA_APP_SECRET` — WhatsApp webhook doğrulaması için
- `ALLOW_LIVE_INTEGRATIONS` — `true` (production'da canlı gönderimler için)

---

## First Deploy

The one-time PM2 bootstrap must be performed deliberately from an already built
immutable release, after confirming that no legacy/duplicate API or portal
worker exists. It must configure the canonical API and submission worker with
`CURRENT_RELEASE_LINK=/opt/findandstudy/current`. The normal deploy script will
hard-fail until this topology exists; it never creates a surprise second
process.

Normal approved releases use:

```bash
cd /opt/findandstudy/source
RUNTIME_ENV_FILE=/etc/findandstudy.env bash deploy/deploy.sh
```

Normal deploys now hard-fail before build or restart unless the effective Nginx
configuration for `APP_BASE_URL` routes through an upstream containing both the
canonical API port and the candidate port marked `backup`. This prevents a
deploy from claiming read-path failover while production still proxies directly
to a single process.

Bu işlem:

1. Reviewed Git commit'ini yeni immutable release dizinine çıkarır.
2. Locked dependencies, typecheck ve build adımlarını release içinde çalıştırır.
3. Migration ledger'ını doğrular; migration uygulamaz.
4. Background jobs kapalı aday API'yi ayrı portta başlatıp HTTP+DB readiness uygular.
5. Aday sağlıklıyken Nginx'i yeniden yükleyip worker upstream durumunu sıfırlar.
6. Canonical PM2 processlerinin `current` symlink'i altında olduğunu doğrular.
7. Symlink'i atomik değiştirir, worker/API'yi bounded drain ile yeniden başlatır.
8. Health başarısızsa yalnız kod symlink'ini önceki release'e döndürür.

### Optional status/lifecycle worker adoption

The status and lifecycle workers are declared in `deploy/ecosystem.config.cjs`
but are intentionally optional in the baseline topology. A normal deploy never
creates them. Once an independently reviewed staging run has proved portal
identity binding, maker-checker behavior, resource limits and rollback, adopt
them once from the already-attested current release:

```bash
cd /opt/findandstudy/current
set -a
. /etc/findandstudy.env
set +a
test "$PORTAL_STATUS_WORKER_MODES" = "status_check"
test "$PORTAL_LIFECYCLE_WORKER_MODES" = "lifecycle_execute"
test -n "$RELEASE_ID"
CURRENT_RELEASE_LINK=/opt/findandstudy/current \
  pm2 start deploy/ecosystem.config.cjs \
  --only findandstudy-portal-status-worker,findandstudy-portal-lifecycle-worker \
  --env production
node deploy/pm2-preflight.cjs --release-link /opt/findandstudy/current
pm2 save
```

Do not add `artifact` or `real` in this adoption step. `artifact` needs a
separate adapter-by-adapter download/storage proof; `real` belongs only to the
submission worker and requires its own production rollout approval. If either
new process fails readiness, stop only those exact names and keep the feature
unavailable; do not reset running submissions from the API.

**Çalıştığını doğrulayın:**

```bash
pm2 status
curl http://localhost:5000/api/healthz
```

> **Nginx kurulumu öncesinde** uygulama doğrudan PORT=5000 üzerinden erişilebilir.
> Nginx kurulduktan sonra `curl http://localhost/api/healthz` çalışmalıdır.

---

## Nginx Setup

> ⚠️ **Önemli:** `deploy/nginx.conf` içindeki `yourdomain.com` ifadelerini gerçek
> domain'inizle değiştirmeyi unutmayın. Değiştirmeden kullanırsanız SSL sertifikası
> alınamaz ve site çalışmaz.

```bash
# Nginx config'ini kopyalayın
sudo cp deploy/nginx.conf /etc/nginx/sites-available/edconsult-os

# 'yourdomain.com' → gerçek domain'inizle değiştirin
sudo nano /etc/nginx/sites-available/edconsult-os

# Siteyi etkinleştirin
sudo ln -s /etc/nginx/sites-available/edconsult-os /etc/nginx/sites-enabled/

# Varsayılan siteyi devre dışı bırakın (isteğe bağlı)
sudo rm -f /etc/nginx/sites-enabled/default

# İsteğe bağlı: Brotli sıkıştırma (gzip'ten daha iyi)
sudo apt install -y libnginx-mod-brotli
# Kurulduktan sonra nginx.conf içindeki brotli direktiflerini yorum satırından çıkarın

# Test edin ve yeniden yükleyin
sudo nginx -t
sudo systemctl reload nginx
```

> **Port kontrolü:** `nginx.conf` upstream bloğunda PM2 API için birincil
> `127.0.0.1:5000`, yalnızca kontrollü deploy sırasında çalışan aday API için
> `127.0.0.1:5057 backup` bulunmalıdır. `PORT=5000` ve
> `CANDIDATE_PORT=5057` değerlerini değiştirmeyin. Nginx değişikliğini ilk kez
> kurarken `nginx -t` başarılı olmadan reload etmeyin.

### Existing multi-site installation

For an existing server, do not manually search-and-replace every virtual host.
After the production preflight has listed the exact files, use the guarded,
idempotent installer. It modifies only the explicitly named files, creates a
dated rollback copy, runs `nginx -t`, validates the effective host route and
reloads Nginx. Any failed validation restores the previous files.

```bash
sudo env \
  RUNTIME_ENV_FILE=/etc/findandstudy.env \
  NGINX_SITE_CONFIGS=/etc/nginx/sites-available/apply.findandstudy.com \
  bash deploy/install-nginx-failover.sh
```

List multiple exact files with `:` separators. Never point this variable at a
directory or wildcard. The installer replaces only direct `proxy_pass` targets
matching the configured canonical `PORT`; unrelated services remain untouched.

---

## SSL with Let's Encrypt

```bash
# Install Certbot
sudo apt install -y certbot python3-certbot-nginx

# Get SSL certificate (replace with your domain)
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

# Certbot will auto-configure Nginx for SSL
# Auto-renewal is set up by default; verify with:
sudo certbot renew --dry-run
```

---

## PM2 Auto-Start & Log Rotation

```bash
# Generate startup script (run as your deploy user)
pm2 startup
# Follow the printed command (sudo env PATH=... pm2 startup ...)

# Save current process list
pm2 save

# Log rotation kurulumu (deploy.sh tarafından otomatik yapılır)
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

Bu sayede uygulama sunucu yeniden başlatmalarında otomatik olarak devreye girer ve
loglar diskinizi doldurmadan döndürülür.

Sistem genelinde logrotate kullanmak istiyorsanız:

```bash
sudo cp /opt/findandstudy/source/deploy/logrotate.conf /etc/logrotate.d/findandstudy
sudo logrotate -d /etc/logrotate.d/findandstudy  # test (dry-run)
```

---

## Controlled Updates

Doğrudan `git pull + build + pm2 reload` kullanmayın. Fork/1 topolojisinde bu
gerçek bir zero-downtime garantisi değildir ve otomatik kod rollback sağlamaz.

```bash
cd /opt/findandstudy/source
RUNTIME_ENV_FILE=/etc/findandstudy.env bash deploy/deploy.sh
```

Candidate readiness veri tabanını değiştirmez. Trafik değişiminden sonraki
health kontrolü başarısız olursa script database, `.env` ve storage'a dokunmadan
önceki kod release'ini geri bağlar.

Doğrulanmış aday API, canonical fork/1 API yeniden başlatılırken Nginx backup
upstream olarak canlı tutulur ve deploy sonunda kapatılır. Aday süreçte
`BACKGROUND_JOBS_ENABLED=false` olduğu için zamanlanmış işler iki kez çalışmaz.
Her iki localhost upstream'de `max_fails=0` kullanılır; böylece farklı Nginx
worker'larının pasif hata sayacı iki sağlıklı portu birden "no live upstreams"
durumuna taşımaz. Aday readiness sonrasında yapılan güvenli Nginx reload'u da
uzun bağlantıların yeni worker'lara temiz upstream durumu ile bağlanmasını sağlar.
Nginx yazma isteklerini otomatik tekrarlamaz; bu koruma restart penceresindeki
GET/HEAD sayfa ve okuma isteklerinin 502 görmesini engellemek içindir.

---

## Database Migrations

> ⚠️ **`drizzle push` production'da KULLANILMAZ** — mevcut tabloları silebilir.

**API boot davranışı:**
`api-server` açılışında DDL, seed, cleanup veya backfill çalışmaz. Eksik şema
normal API başlangıcında otomatik düzeltilmez; migration ayrı ve açıkça
onaylanmış bir operasyon olmalıdır.

**Manuel şema değişikliği (Drizzle migration):**

```bash
# 1. lib/db dizininde migration SQL'i oluşturun
cd lib/db
pnpm drizzle-kit generate

# 2. Oluşan SQL dosyasını gözden geçirin
cat drizzle/<timestamp>_migration.sql

# 3. Ledger doğrulamasını çalıştırın
node validate-migrations.mjs

# 4. Ayrı migration runbook'u ve açık production onayı olmadan ilerlemeyin.
```

Fresh veya mevcut uzun ömürlü staging veritabanları genel local runner ile
`development` olarak yanlış sınıflandırılmaz. Yalnız `fasos_staging`, loopback
client hedefi, exact clean source commit, exact pre-ledger count, PostgreSQL'in
raporladığı server identity, doğrudan least-privilege `fas_migrator`, sabit pnpm
sürümü ve advisory lock birlikte doğrulandığında dedicated runner kullanılabilir:

```bash
cd /opt/findandstudy-staging/source/lib/db
ALLOW_STAGING_MIGRATIONS=true \
MIGRATION_TARGET_ENV=staging \
MIGRATION_STAGING_CHANGE_ID=stg-YYYYMMDDTHHMMSSZ-<commit12> \
MIGRATION_EXPECTED_SOURCE_COMMIT=<approved-40-character-commit> \
MIGRATION_EXPECTED_APPLIED_COUNT=<approved-current-ledger-count> \
MIGRATION_CONFIRMED_HOST=127.0.0.1 \
MIGRATION_CONFIRMED_PORT=<loopback-published-port> \
MIGRATION_CONFIRMED_DATABASE=fasos_staging \
MIGRATION_CONFIRMED_USER=fas_migrator \
MIGRATION_CONFIRMED_SERVER_ADDRESS=<postgresql-reported-address> \
MIGRATION_CONFIRMED_SERVER_PORT=<postgresql-reported-port> \
DATABASE_URL=<secret-loopback-fasos-staging-url> \
node ./run-staging-migrations.mjs
```

`MIGRATION_EXPECTED_APPLIED_COUNT` sıfırdan büyükse aynı change window için
`MIGRATION_STAGING_BACKUP_ID` de zorunludur. Araç production veritabanı adını,
uzak DB hostunu, farklı executor'ı, dirty source'u, ledger drift'ini ve `push`
fallback'ini fail-closed reddeder.

---

## Public Endpoints (Anonim Yüzey)

Aşağıdaki endpoint'ler oturum gerektirmez ve internetten erişilebilirdir.
Bu bilinçli bir tasarım tercihidir — nginx rate limiting ile korunurlar.

| Endpoint                                  | Açıklama                                      | Rate Limit   |
| ----------------------------------------- | --------------------------------------------- | ------------ |
| `GET /api/healthz`                        | Uygulama sağlık kontrolü                      | —            |
| `GET /api/destinations`                   | Aktif ülke/üniversite listesi (Course Finder) | API zone     |
| `POST /api/public-apply`                  | Öğrenci başvuru formu                         | API zone     |
| `GET /api/public/sign/:token`             | Sözleşme imza sayfası                         | sign limiter |
| `POST /api/public/sign/:token/sign`       | Sözleşme imzalama                             | sign limiter |
| `GET /api/public/sign/:token/pdf`         | İmzalı PDF indirme                            | sign limiter |
| `POST /api/webhooks/whatsapp`             | WhatsApp Cloud API webhook                    | API zone     |
| `GET /api/webhooks/whatsapp`              | WhatsApp webhook doğrulama                    | API zone     |
| `GET /api/embed/public/*`                 | Embed widget kamuya açık API                  | API zone     |
| `GET /public/website-forms/:slug/check`   | Website form varlık kontrolü                  | API zone     |
| `POST /public/website-forms/:slug/submit` | Website form gönderimi                        | API zone     |

**Güvenlik notları:**

- Sözleşme endpoint'leri cryptographic token ile korunur (hashToken)
- WhatsApp webhook HMAC-SHA256 imzası doğrulanır (`WA_APP_SECRET`)
- Embed widget API key ile doğrulanır; domain allowlist kontrolü yapılır
- `POST /api/public-apply`: e-posta bazlı IDOR koruması mevcuttur

---

## Rollback

`deploy/deploy.sh`, cutover sonrası health başarısızlığında `current` symlink'ini
otomatik olarak önceki immutable release'e döndürür; canonical API/submission
worker'ını ve daha önce benimsenmişse status/lifecycle worker'larını yeniden
başlatır. Manuel rollback gerekirse aynı doğrulanmış
symlink işlemi ve exact process adları kullanılmalıdır. `pm2 delete all`,
`restart all`, database restore veya storage rollback bu runbook'un parçası
değildir.

---

## Monitoring

```bash
# Real-time logs
pm2 logs

# Process status
pm2 status

# CPU/Memory monitoring dashboard
pm2 monit

# Nginx access logs
sudo tail -f /var/log/nginx/access.log

# Nginx error logs
sudo tail -f /var/log/nginx/error.log

# PostgreSQL logs
sudo tail -f /var/log/postgresql/postgresql-16-main.log
```

---

## Troubleshooting

### App not starting

```bash
# PM2 log'larını kontrol edin
pm2 logs fasos-apply-api --lines 50

# Port kullanımda mı?
sudo lsof -i :5000

# Hatayı doğrudan görmek için manuel çalıştırın
cd /var/www/edconsult-os
NODE_ENV=production PORT=5000 node artifacts/api-server/dist/index.cjs
```

### Database connection issues

```bash
# PostgreSQL bağlantısını test edin
psql "$DATABASE_URL" -c "SELECT 1;"

# PostgreSQL çalışıyor mu?
sudo systemctl status postgresql
```

### Nginx 502 Bad Gateway

```bash
# App may not be running
pm2 status

# Check nginx error log
sudo tail -f /var/log/nginx/error.log

# Verify upstream port matches ecosystem.config.cjs PORT
```

### Frontend not loading / blank page

```bash
# Verify frontend was built
ls -la artifacts/edcons/dist/public/

# Verify index.html exists
ls -la artifacts/edcons/dist/public/index.html

# Rebuild if needed
bash deploy/build-production.sh
pm2 restart all
```

### Permission errors

```bash
# Ensure the app directory is owned by your deploy user
sudo chown -R $USER:$USER /var/www/edconsult-os

# Ensure log directory exists
mkdir -p /var/www/edconsult-os/logs
```

### Memory issues

```bash
# Check memory usage
free -h
pm2 monit

# Reduce cluster instances in ecosystem.config.cjs if needed
# Change instances: "max" to instances: 2
```
