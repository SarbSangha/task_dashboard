# Cloudflare Edge Setup

This project now includes a same-repo Cloudflare Worker edge layer in [wrangler.toml](/d:/TASK SYSTEM/my-dashboard/wrangler.toml) and [worker.js](/d:/TASK SYSTEM/my-dashboard/cloudflare/worker.js).

The current implementation uses:

- Layer 1: Worker memory cache
- Layer 2: Cloudflare KV
- Layer 3: FastAPI origin at `https://task-dashboard-fg5d.onrender.com`

Hyperdrive is already bound in config so the next phase can move selected Lane B reads into the Worker without changing the deployment shape again.

## What The Worker Caches

Only the existing Lane B task endpoints are cached at the edge:

- `/api/tasks/all` for 60 seconds
- `/api/tasks/assets` for 90 seconds

Realtime and write-heavy routes continue to proxy straight to FastAPI.

## Create Hyperdrive

Run the Hyperdrive create command with your direct Supabase Postgres connection:

```bash
npx wrangler hyperdrive create my-dashboard-hyperdrive --connection-string="postgresql://postgres:YOUR_PASSWORD@db.bqfpocatqqlxppvcpzot.supabase.co:5432/postgres"
```

Use the direct database port `5432`, not the Supabase pooler port `6543`.

## Create KV

Create one KV namespace for global edge cache storage:

```bash
npx wrangler kv namespace create DASHBOARD_KV
npx wrangler kv namespace create DASHBOARD_KV --preview
```

Then copy the returned IDs into [wrangler.toml](/d:/TASK SYSTEM/my-dashboard/wrangler.toml).

## Bind Secrets

Set the purge secret in Cloudflare:

```bash
npx wrangler secret put PURGE_SECRET
```

Local development values can be stored in [`.dev.vars.example`](/d:/TASK SYSTEM/my-dashboard/.dev.vars.example) copied to `.dev.vars`.

## Local Development

Use:

```bash
npm run cf:dev
```

Useful routes:

- `/edge/health` to verify FastAPI, KV, and Hyperdrive bindings
- `/edge/purge` for backend-triggered cache invalidation

## Frontend API Target

After the Worker is deployed, set:

```env
VITE_API_URL=https://RMWworker.<your-workers-subdomain>.workers.dev
```

This keeps SPA assets and API traffic on the same edge layer while the Worker proxies websocket upgrades and uncached API routes back to FastAPI.
