# AuthPilot — Running Locally & Deploying

## 1. Run the UI on localhost (default: SQLite, zero containers)

Once the Next.js app is scaffolded:

```bash
cp .env.example .env            # fill in QWEN_API_KEY / QWEN_API_BASE at minimum
npm install
npx prisma migrate dev          # creates the SQLite dev.db
npm run seed                    # loads demo payers / patients / cases
npm run dev                     # http://localhost:3000
```

The dashboard, intake, case-detail (live trace), audit, and analytics pages are all served
by Next.js on port 3000. No Docker is needed for the default SQLite setup.

## 2. Optional: switch SQLite → Postgres

AuthPilot keeps the "one env change to Postgres" story:

1. Start Postgres locally:
   ```bash
   docker compose up -d postgres        # postgres:16 on localhost:5433
   ```
2. In `prisma/schema.prisma`, change the datasource provider:
   ```prisma
   datasource db {
     provider = "postgresql"   // was "sqlite"
     url      = env("DATABASE_URL")
   }
   ```
3. Point `DATABASE_URL` at Postgres in `.env`:
   ```
   DATABASE_URL=postgresql://authpilot:authpilot@localhost:5433/authpilot
   ```
4. Re-run migrations: `npx prisma migrate dev`.

Everything else (app code, queries) is unchanged — Prisma abstracts the engine.

## 3. WhatsApp channel (optional)

- Fill in the `WHATSAPP_*` keys in `.env` (all four, or none — `lib/config.ts` enforces this).
- Point your Meta app's webhook at `https://<your-host>/api/whatsapp/webhook` with the same
  `WHATSAPP_VERIFY_TOKEN`.
- One-off Meta-side setup: `npx tsx scripts/setup-whatsapp.ts` (ice-breakers + commands).
- Locally, expose the webhook with a tunnel (e.g. `ngrok http 3000`) or use the dev simulator
  that signs a fake payload with `WHATSAPP_APP_SECRET`.

See `whatsapp-integration/README.md` for the full inbound/outbound behavior and the safety
boundary (PHI stays in-app; WhatsApp carries triggers, generic status, and staff approvals only).

## 4. Deploy

### Recommended: Vercel (native)
Connect the repo in Vercel and set the env vars in the Vercel dashboard. Every push to `main`
auto-deploys. Use a hosted Postgres (Vercel Postgres / Neon / Supabase) for `DATABASE_URL` in
production — the local SQLite file does not persist on serverless.

`.github/workflows/deploy.yml` provides an optional explicit CLI-based deploy gated on CI, for
teams that prefer that over the native integration (needs `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
`VERCEL_PROJECT_ID` secrets).

### Alternative: self-hosted (Docker)
Build the provided `Dockerfile` (Next.js standalone) and run it behind your reverse proxy,
with the `postgres` service from `docker-compose.yml`. This mirrors a server-clone + rebuild
model if you deploy to your own box instead of Vercel.

## 5. CI

`.github/workflows/ci.yml` runs on every PR and push to `main`: install → `prisma generate`
→ typecheck → lint → test (unit + fast-check property tests) → gold-case eval → `next build`.
It self-skips until the app is scaffolded (no `package.json` yet).
