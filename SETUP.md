# TASK SYSTEM — Setup Requirements (new machine)

Everything needed to reproduce this environment on another system. Three deployable pieces plus one edge worker:

| Part | Path | Stack |
|---|---|---|
| Backend API | `backend/` | Python + FastAPI + SQLAlchemy |
| Frontend | `my-dashboard/` | Node + Vite + React 18 |
| Edge worker | `my-dashboard/cloudflare/` | Cloudflare Workers (wrangler) |
| Browser extension | `browser-extension/tool-hub-autologin/` | Chrome MV3, no build step |

---

## 1. System-level prerequisites

Install these first, before touching the repo.

| Tool | Version | Notes |
|---|---|---|
| **Python** | 3.11.x | `runtime.txt` pins `python-3.11.9` (root) / `python-3.11.11` (backend) for Render. See "Version drift" below. |
| **Node.js** | 20–24 | `package.json` `engines: ">=20 <25"`. This machine runs v24.14.1, npm 11.11.0. |
| **Git** | any recent | |
| **ffmpeg** | any recent, on `PATH` | Required for video thumbnail generation ([upload.py:232](backend/routers/upload.py#L232)). Without it that one endpoint returns 503; everything else works. |
| **PM2** | latest (`npm i -g pm2`) | Production process manager only — `backend/ecosystem.config.cjs`. Not needed for local dev. |
| **PostgreSQL client** | optional | Only if you want to restore the `.dump` / `.sql` backups in the repo root. |

Not required to install locally (hosted services):
- **PostgreSQL / Supabase** — the app connects to a remote Postgres via `DATABASE_URL`.
- **Redis** — optional cache. If `REDIS_URL` is blank the app runs without it.
- **Cloudflare R2** — optional object storage for uploads.

---

## 2. Backend

```bash
cd backend
python -m venv venv
# Windows
venv\Scripts\activate
# Linux/macOS
source venv/bin/activate

pip install -r requirements.txt
```

### Pinned dependencies (`backend/requirements.txt`)

```
fastapi>=0.115.0,<1.0.0
uvicorn[standard]>=0.30.0,<1.0.0
sqlalchemy>=2.0.30,<3.0.0
passlib==1.7.4
bcrypt==4.0.1
python-jose[cryptography]==3.3.0
cryptography>=42.0.0,<47.0.0
python-multipart>=0.0.9,<1.0.0
itsdangerous>=2.1.2,<3.0.0
email-validator>=2.1.0,<3.0.0
pydantic[email]>=2.10.0,<3.0.0
psycopg[binary]>=3.2.13,<4.0.0
boto3>=1.35.0,<2.0.0
redis>=5.0.0,<6.0.0
aiocache>=0.12.0,<1.0.0
httpx>=0.27.0,<1.0.0
pywebpush>=2.0.3,<3.0.0
Pillow>=10.4.0,<12.0.0
openpyxl>=3.1.0,<4.0.0
python-pptx>=0.6.23,<1.1.0
```

**Optional, not in requirements.txt:**
- `pip install weasyprint` → enables server-side PDF export. Needs system cairo/pango libraries. Without it, the Report Builder falls back to browser "Print / Save as PDF" ([report_exports.py:196](backend/utils/report_exports.py#L196)).

**No `python-dotenv` needed** — `backend/database_config.py` has its own lightweight `.env` loader.

### Run migrations, then start

```bash
python run_db_migrations.py
python -m uvicorn main:app --reload --port 8000
```

Health check: `GET http://localhost:8000/api/health`

---

## 3. Backend environment variables

Copy `backend/.env.local.example` → `backend/.env` and fill in. Full inventory of what the code reads:

### Required
| Var | Purpose |
|---|---|
| `SECRET_KEY` | JWT/session signing. Long random string. |
| `DATABASE_URL` | Main Postgres, e.g. `postgresql://user:pass@host:5432/db` |
| `ARCHIVE_DATABASE_URL` | Archive Postgres (separate DB) |
| `ENVIRONMENT` | `development` or `production` |
| `FRONTEND_URL` | `http://localhost:5173` locally |
| `CORS_ORIGINS` | Comma-separated, e.g. `http://localhost:5173,http://127.0.0.1:5173` |

### Cookies / auth
`COOKIE_SECURE` (`false` local / `true` prod), `COOKIE_SAMESITE` (`lax` local / `none` prod), `SESSION_EXPIRE_HOURS`, `ALLOWED_COMPANY_EMAIL_DOMAINS`, `AUTH_REQUIRE_REDIS`, `AUTH_RESPONSE_CACHE_TTL_SECONDS`, `AUTH_CLEANUP_INTERVAL_SECONDS`, `LOGIN_RATE_LIMIT_ATTEMPTS`, `LOGIN_RATE_LIMIT_WINDOW_SECONDS`, `CORS_ALLOW_ORIGIN_REGEX`

### DB pool tuning
`DB_POOL_SIZE`, `DB_MAX_OVERFLOW`, `DB_POOL_TIMEOUT`, `DB_POOL_RECYCLE`, `DB_EXTERNAL_POOLER`, `DB_USE_NULL_POOL`, `DB_USE_SQLALCHEMY_POOL`, `DB_SQL_ECHO` / `SQLALCHEMY_ECHO`

> Keep pools tiny locally (`DB_POOL_SIZE=1`, `DB_MAX_OVERFLOW=0`) — the Supabase session pooler is strict about client counts.

### Credential vault (IT Tools / extension auto-login)
| Var | How to generate |
|---|---|
| `TOOL_CREDENTIAL_ENCRYPTION_KEY` | `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `TOOL_CREDENTIAL_LAUNCH_SECRET` | any long random string |

Both fall back to `SECRET_KEY` if unset, but set them explicitly.

### Optional — R2 storage
`R2_ENDPOINT`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `R2_BUCKET`, `R2_REGION` (`auto`), `R2_PUBLIC_BASE_URL`

### Optional — Redis & edge cache
`REDIS_URL`, `EDGE_CACHE_PURGE_URL`, `EDGE_CACHE_PURGE_SECRET`

### Optional — Web push
`WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, `WEB_PUSH_SUBJECT`

### Optional — SMTP (password reset + report email)
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME` / `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` / `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`, `SMTP_USE_SSL`, `SMTP_USE_TLS`, `SMTP_STARTTLS`, `PASSWORD_RESET_URL` / `RESET_PASSWORD_URL`

### Optional — first-run admin bootstrap
`DEFAULT_ADMIN_EMAIL`, `DEFAULT_ADMIN_BOOTSTRAP_PASSWORD`, `DEFAULT_ADMIN_ROLES` (`admin,root`)

### Misc
`LOAD_DOTENV`, `LOAD_DOTENV_OVERRIDE`, `RUN_STARTUP_SCHEMA_SYNC`, `INBOX_PROFILE_LOGGING`, `SLOW_REQUEST_LOG_MS`, `NOTIFICATION_QUEUE_MAX_SIZE`, `NOTIFICATION_QUEUE_WORKERS`, `WEB_CONCURRENCY`, `RENDER`

---

## 4. Frontend

```bash
cd my-dashboard
npm ci        # use npm ci — package-lock.json is committed
npm run dev   # http://localhost:5173
```

### Dependencies
```
@tanstack/react-query ^5.96.0      react ^18.3.1
@tanstack/react-query-devtools     react-dom ^18.3.1
axios ^1.13.5                      react-markdown ^10.1.0
react-router-dom ^7.13.0           react-window ^2.2.7
recharts ^3.9.2                    remark-gfm ^4.0.1
```
Dev: `vite ^5.4.10`, `@vitejs/plugin-react ^4.3.3`, `eslint ^9.13.0` (+ react / react-hooks / react-refresh plugins), `globals`, `@types/react`, `@types/react-dom`, `@eslint/js`

### Environment
Create `my-dashboard/.env.local`:
```
VITE_API_URL=http://localhost:8000
```
Production uses the Cloudflare Worker URL instead of hitting FastAPI directly.

### Scripts
`npm run dev` · `build` · `preview` · `lint` · `cf:dev` · `cf:dev:remote` · `cf:deploy`

---

## 5. Cloudflare Worker (optional — only if reproducing the edge layer)

```bash
npm i -g wrangler     # or use npx
npx wrangler login
```

`my-dashboard/wrangler.toml` needs **your own** resource IDs — the committed ones point at the existing account:

```bash
npx wrangler kv namespace create DASHBOARD_KV
npx wrangler kv namespace create DASHBOARD_KV --preview
npx wrangler hyperdrive create my-dashboard-hyperdrive \
  --connection-string="postgresql://postgres:PASSWORD@db.<project>.supabase.co:5432/postgres"
npx wrangler secret put PURGE_SECRET
```

Use direct Postgres port `5432` for Hyperdrive, not the pooler port `6543`. Full detail in [CLOUDFLARE_HYPERDRIVE.md](my-dashboard/CLOUDFLARE_HYPERDRIVE.md).

---

## 6. Browser extension

No build, no dependencies. `chrome://extensions` → Developer mode → **Load unpacked** → select `browser-extension/tool-hub-autologin/`.

Manifest V3. If your dashboard runs on a different host/port than the ones listed, add it to `host_permissions` in `manifest.json` (currently covers `localhost`, `127.0.0.1`, `192.168.1.15`, `*.ritzmediaworld.in`, `*.ritzmediaworld.com`).

---

## 7. Production deploy shape (for reference)

- **Render** — `render.yaml`: backend web service (`pip install -r requirements.txt` + uvicorn) and static site (`npm install && npm run build` → `dist`).
- **Self-hosted droplet** — `.github/workflows/deploy.yml` SSHes in on push to `main`, rebuilds venv, runs `run_db_migrations.py`, `npm ci && npm run build`, then `pm2 reload backend`.
- PM2 config: `backend/ecosystem.config.cjs` (2 workers, `venv/bin/python3 -m uvicorn`). The `script` path is POSIX — on Windows it would need `venv\Scripts\python.exe`.

---

## Version drift to be aware of

Three things don't line up in the current setup. Worth deciding on before you replicate:

1. **Python version.** `runtime.txt` (root) says 3.11.9, `backend/runtime.txt` says 3.11.11, but the local venv on this machine was built with **Python 3.14.3**. Production runs 3.11. For a matching-behaviour system, install **3.11.x** and build the venv from it.
2. **`Pillow` and `python-pptx` are in requirements.txt but not installed** in the current local venv. Both are guarded by try/except, so image handling in uploads and PPTX report export silently degrade rather than crash. A clean `pip install -r requirements.txt` on the new machine will install them — which is the correct state.
3. **Node 24 locally vs `engines: ">=20 <25"`** — within range, but Render/droplet may use a different major. Node 20 LTS is the safest choice for the new machine.
