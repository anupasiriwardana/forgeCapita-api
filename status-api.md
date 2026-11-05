# ForgeCapita API — Service Status & Technical Health Report

**Service:** `forgecapita-api` (Off-Chain Microservice)  
**Runtime:** Node.js 22 / Express.js / TypeScript  
**Database:** Neon PostgreSQL (Shared with Ponder Indexer)  
**Port:** 3001  
**Last Updated:** 2026-11-05  

**Current focus:** Step: WS-01.2 (API-03, API-04, API-05, API-97) | State: awaiting-review | Updated: 2026-11-05  

---

## 1. Executive Summary

The `forgecapita-api` service provides the off-chain data layer, hybrid SQL joins with Ponder indexer tables, Paymaster gas debt recoupment signatures, and compliance auditing. 

Currently, basic server setup, PostgreSQL pool connections, startup profile upsertion, and unified on-chain/off-chain project retrieval are operational. However, **several critical runtime issues, missing endpoints, and empty stub files prevent the service from supporting the full architecture specified in `about.md`**.

---

## 2. Operational Features (Working)

- **Database Connection & Initialization:**
  - `src/db/pool.ts` connects cleanly to the Neon PostgreSQL instance with SSL.
  - Automatically verifies and creates the `startup_profiles` table on server boot.
- **Health Check Endpoint:**
  - `GET /health` verifies server uptime and database connectivity.
- **Unified Projects Querying (The SQL JOIN):**
  - `GET /api/projects`: Successfully executes a `LEFT JOIN` between Ponder's on-chain `project` table and `startup_profiles` to return a unified array of active startups.
  - `GET /api/projects/:projectId`: Fetches a single merged startup record by escrow address.
- **Basic Profile Upsert:**
  - `POST /api/projects/profile`: Upserts startup metadata (`name`, `description`, `logo_url`, `pitch_deck_url`, `founder_bio`, `website_url`, `shadow_wallet`) using `ON CONFLICT (project_id) DO UPDATE`.
- **Environment validation (2026-11-01):** `src/config/env.ts` validates `DATABASE_URL` (postgres(ql)://), `PORT` (1..65535, default 3001) and `NODE_ENV` with zod at boot; invalid config prints variable names only and exits 1. `src/index.ts` and `src/db/pool.ts` use it.
- **Paymaster removed (2026-11-01):** routes, controller and service deleted; replaced later by the relayer (API-70+).
- **Hardening (2026-11-05, WS-01.2, awaiting review):** `src/app.ts` (`createApp()`, no port bound) with request id, pino-http logging (path without query), helmet (CSP `default-src 'none'`, HSTS in production), exact-match CORS allow-list (no credentials; no-Origin allowed; foreign Origin gets 403 on every route; preflight 204), global rate limit (120/min) plus 10/min on `POST /api/projects/profile`, `/health` exempt, `/health/db` limited, JSON body limit (`BODY_LIMIT`), strict zod validation (`src/schemas`, `src/middlewares/validate.ts`), uniform error body with no stack/SQL/host in any NODE_ENV (`errorHandler.ts`), pino redaction, graceful shutdown (server close, pool end, 10 s hard timeout), `dotenv` quiet. SQL and pg `ssl` option untouched.
- **Operations before production:** restart the api container (the compose service runs `tsx watch`, which may already have reloaded); set `CORS_ORIGINS` (required and non-empty in production) and `TRUST_PROXY=1` behind Render (with 0 all clients share the proxy IP and one global bucket); `.env.example` documents all new variables.

---

## 3. Critical Issues & Immediate Blockers

### A. Typecheck tooling (API-96)
- `npx tsc --noEmit` reports 89 TS1295/TS1287 errors (41 before WS-01.2; the new files add the same kind; nothing else is reported, so real type errors are hidden). CommonJS package vs NodeNext + verbatimModuleSyntax. tsx and jest work. User decision needed.

### A2. Findings from the WS-01.2 close (2026-11-05)
- Bare 4xx errors from libraries become 500 (e.g. `URIError` with `status 400` from the Express 5 router on a bad `%` escape in a path). Recommended small fix, user decision pending: honour numeric `status`/`statusCode` 400-499 with `expose === true`, generic message per status.
- Minor: `/health/db` logs the full pg error in production; redaction covers one nesting level; `/health/` with trailing slash is not exempt from the limiter or request log filter; preflights are not rate limited; express-rate-limit prints its own console warning if `X-Forwarded-For` arrives while `TRUST_PROXY=0`; LF files will be shown as CRLF-converted by git (cosmetic, no `.gitattributes`).
- Audit logging: `auditLogger` exists, nothing writes to it yet.

### B. Missing `status` Column in `startup_profiles`
- **Status:** **HIGH PRIORITY** ⚠️
- **Problem:** `src/db/pool.ts` creates `startup_profiles` with `shadow_wallet` and `kyc_verified`, but lacks the `status VARCHAR` column (`'PENDING'`, `'APPROVED'`, `'REJECTED'`, `'ROGUE'`).
- **Impact:** The architectural decision to enforce **Pre-Launch UI Gating** (Section 3.B of `about.md`) cannot be implemented because there is no column tracking whether an admin has approved a founder's submission.
- **Remedy Required:** Alter table or update initialization script to include `status VARCHAR NOT NULL DEFAULT 'PENDING'`.

### C. Missing Environment Variables & Configuration
- **Status:** **CONFIG BLOCKER** ⚠️
- **Problem:** `.env.example` now lists `DATABASE_URL`, `PORT`, `NODE_ENV` (the treasury key is intentionally never on the server). Still missing for later steps:
  2. `ETHERSCAN_API_KEY` & `BSCSCAN_API_KEY`: Required by `auditService.ts` to query explorer APIs for fiat/crypto transfers into shadow wallets.
  3. `JWT_SECRET`: Required for Web3 SIWE session tokens.
  4. S3/Cloud Storage credentials for logo uploads.
- **Remedy Required:** Update `.env.example` and populate `.env` with valid keys.

---

## 4. Incomplete Workflows & Architectural Gaps

### A. Secret Shopper Audit Service (`src/services/auditService.ts`)
- `auditService.ts` contains only a skeleton `cron.schedule("0 0 * * 0", ...)` with console logs and commented placeholders.
- The cron job is **never invoked** in `src/index.ts`.
- No HTTP client integration with Etherscan/BscScan APIs exists to inspect incoming shadow wallet transactions.
- No discrepancy calculation comparing shadow wallet receipts against Ponder's indexed `RevenueRouter` deposits.

### C. Logo File Uploading
- Currently expects a raw URL string in `logo_url`.
- Needs `multer` integration and cloud storage bucket persistence (AWS S3 or Supabase Storage) to handle direct file uploads.

### D. Authentication & Role-Based Access Control
- All endpoints are currently unauthenticated.
- No Sign-In with Ethereum (SIWE) or wallet signature verification is implemented.
- Founders can overwrite any `project_id` in `POST /api/projects/profile` without verifying ownership.

### E. Dashboard Endpoints (Admin, Founder, Investor)
- No role-specific aggregation routes exist for:
  - Admin (reviewing pending applications, KYC verification, rogue contract alerts, emergency shutdown trigger).
  - Founder (project analytics, Paymaster gas debt status, shadow wallet registration).
  - Investor (portfolio overview, dividend yield claimed, active voting alerts).

---

## 5. Plan revision (2026-10-28)

The backlog was rewritten to a production-grade plan. Key changes from what this report described:

- **Accounts instead of wallet-only auth:** email + password with sessions, roles `investor / founder / staff / admin`, wallet linking, mandatory TOTP for staff and admin (API-11 to API-22). The SIWE-as-login idea is dropped.
- **Gas model:** the treasury-signature Paymaster and the `gas_debt_records` table are dropped. Claim tokens, stake, vote and execute milestone become gasless through a relayer wallet with a gas oracle and a queue (API-70 to API-80). This needs contracts v2 (`backlog-contracts.md`). The API no longer holds the treasury key.
- **Founder trust pipeline:** application state machine, manual KYC, "I agree" Revenue Share Agreement, GitHub/GitLab repo provisioning, public shadow wallet with approved changes (API-30 to API-40).
- **Revenue integrity:** reconciliation including allow-listed ERC-20 tokens in USD with a tolerance, compliance state machine with a 14-day clock, Secret Shopper worker, freeze coupling (API-45 to API-55).
- **Complaints and takeover workflow** (API-60 to API-63), staff/admin dashboards (API-81).
- **Platform hardening:** migrations, validation, helmet / CORS / rate limits, structured logging, readiness, tests (API-01 to API-10, API-90 to API-95).

## 6. Summary Checklist of Next Steps

1. [x] API-01 remove the broken Paymaster mount; API-02 zod env validation (done 2026-11-01; user must check `.env` DATABASE_URL scheme).
2. [ ] API-03 to API-05 and API-97 done 2026-11-05 (awaiting review); next API-06 to API-08 (WS-01.3: migrations, `app` schema, pagination), then API-09/API-10 readiness and versioning.
3. [ ] `[USER-ACTION]` API-16 / API-17: email provider and admin bootstrap, then API-11 to API-22 accounts and roles.
4. [ ] API-30 to API-40 application, KYC, agreement and repo workflow.
5. [ ] After contracts v2 are deployed: API-70 to API-80 relayer.

## Change log

2026-11-05  WS-01.2  API-03, API-04, API-05, API-97 ticked (audit logger created but unused); new `app.ts`, `errors.ts`, `logger.ts`, `rateLimit.ts`, `requestId.ts`, `validate.ts`, `schemas/`; `index.ts` graceful shutdown; helmet 8.3.0, express-rate-limit 8.7.3, pino 10.4.0, pino-http 11.0.0, pino-pretty 13.2.0 added (lockfile checked); findings: 400-vs-500 for library 4xx, minor logging/limiter items (see 3.A2); API-96 stays open (tsc 89 errors, all TS1295/TS1287)  - verified by: reading all src files and tests, `docker compose exec api npm test` 3 suites 39/39, `npx tsc --noEmit` 89 errors all TS1295/TS1287, grep: only two console.error in env.ts, no req.body logging; NOT verified: real DB boot, Render proxy hops, browser CORS, shutdown signals, pino-pretty

2026-11-01  re-plan  v2-first re-plan approved by the user; no API step changes (WS-01.2 onward unchanged); docs only  - verified by: not applicable (no code touched)
2026-11-01  WS-01.1  API-01 paymaster removed; API-02 zod env config (src/config/env.ts), zod added, jest setupEnv; new backlog API-96 (tsc TS1295 tooling, predates step), API-97 (dotenv log line)  - verified by: npm test 8/8, grep for paymaster/TREASURY_PRIVATE_KEY clean, negative boots (bad URL, PORT=0, bad NODE_ENV) exit 1; npx tsc --noEmit still 41 TS1295/TS1287 errors (pre-existing); "required" branch and valid-env boot against a real DB not verified by tracker
