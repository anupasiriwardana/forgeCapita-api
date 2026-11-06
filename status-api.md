# ForgeCapita API — Service Status & Technical Health Report

**Service:** `forgecapita-api` (Off-Chain Microservice)  
**Runtime:** Node.js 22 / Express.js / TypeScript  
**Database:** Neon PostgreSQL (Shared with Ponder Indexer)  
**Port:** 3001  
**Last Updated:** 2026-11-07  

**Current focus:** Step: WS-07.7 (draft TTL 7 days, reconcile shutdown race fix; frontend /launches) | State: awaiting-review | Updated: 2026-11-07. USER-ACTION: `docker compose restart api` (no migrations). Draft flow user-reported working end to end after the SQL hotfix (not verified by Claude). Profile application by the reconcile job not explicitly confirmed.

**WS-07.6a done (tracker-verified by reading migration 009, reconcile.ts, draftService.ts, draftRoutes.ts, founderRepository diff; `docker compose exec -T api npm test` 10 suites 211/211; tsc only TS1295/TS1287; package files unchanged; NOT run on real Postgres).** Profile and shadow wallet reservation are saved BEFORE the on-chain launch (`/api/v1/launch-drafts`); after launch the escrow is attached and a 15 s reconcile job applies the profile once the indexer has the project and the developer matches (ponder `project.id` = `chainId:escrow`, `developer` column confirmed in ponder.schema.ts). Known gaps: attached drafts never expire if the developer never matches; a pending draft expires after 2 h (late confirmation needs ProfileEditor); see API-101..105. USER-ACTION after review/commit: `docker compose exec -T api npm run migrate` (expect 001-009), `docker compose exec -T api npm run migrate:status` (0 pending), `docker compose restart api`, GET /ready ok.

(Previous focus: WS-07.5a, shadow wallet pool, migration 008, awaiting-review.)

**WS-07.5a done (tracker-verified by reading migration 008, upsertProfile CTE, projectService binding flow, and `docker compose exec -T api npm test` 9 suites 188/188; tsc only TS1295/TS1287; package.json unchanged; NOT run on real Postgres).** A founder holds a pool of staff-approved wallets (one pending at a time); each project binds one approved wallet via `shadowWalletId` (or `shadowWallet`; both => 400), each wallet to at most one project; rebinding a different wallet 409; bind audited as `shadow_wallet.bind`; `GET /founders/me` returns `{agreement, wallets:[...]}`; the wallet is never in public DTOs. Non-staff/admin callers need an approved application + accepted agreement. KNOWN INTERIM BREAK: the existing frontend create-project page saves the profile without a wallet reference, so that save fails (403/400) until WS-07.5l lands; the on-chain launch is unaffected. USER-ACTION after review/commit: `docker compose exec -T api npm run migrate` (expect 001-008), `docker compose exec -T api npm run migrate:status` (0 pending), `docker compose restart api`, GET /ready ok.

## BLOCKED - create-project profile save (until WS-07.5l)
Why: `POST /projects/profile` now requires `shadowWalletId` and launch-eligibility; the frontend does not send them yet.
You need to do: nothing now; wait for WS-07.5l (frontend wallet pool, eligibility, create gating).
How to confirm (no secrets in chat): after WS-07.5l, create a project and see the profile saved.
Then run: /next-task WS-07.5l

**WS-07.2l done (tracker-verified by reading migration 007, agreement.ts, founderRepository.ts, founderService.ts, founderRoutes.ts, app.ts mounts, and `docker compose exec -T api npm test` 9 suites 178/178; tsc only TS1295/TS1287; package.json and `POST /projects/profile` untouched; NOT run on real Postgres).** Endpoints: `GET /api/v1/agreement`; founder `POST /api/v1/founders/me/agreement` (wallet signature, 10 min window, 409 on replay), `POST .../me/shadow-wallet`, `GET .../me`, `GET .../me/launch-eligibility`; staff/admin `GET /api/v1/admin/shadow-wallets`, `POST .../:id/approve|reject` (pending-only, FOR UPDATE, own wallet 403, audit rows). Agreement text is a DRAFT placeholder. openapi.ts not updated. USER-ACTION after review/commit: `docker compose exec -T api npm run migrate` (expect 001-007), `npm run migrate:status` (0 pending), `docker compose restart api`, GET /ready ok. No UI yet.

**WS-07.1l done (tracker-verified by reading migration 006, repository CTEs, service, routes, schemas, and `docker compose exec -T api npm test` 8 suites 157/157; tsc only TS1295/TS1287; NOT run on real Postgres).** `POST /api/v1/applications`, `GET /api/v1/applications/mine`, staff/admin `GET /api/v1/admin/applications[/:id]`, `POST .../:id/approve` (needs `kycVerified: true`) and `/reject` (needs note). Single-statement CTEs, pending-only; approve grants `founder` only from `investor`, revokes sessions only when the role changed, audit rows application.approve/application.reject/role.change. Own application: 403 before 409. USER-ACTION after review/commit: `docker compose exec -T api npm run migrate` (expect 001-006), `npm run migrate:status` (0 pending), `docker compose restart api`, GET /ready ok. No UI yet.

**WS-06.7w done (tracker-verified by reading code and `docker compose exec -T api npm test` 145/145; tsc only TS1295/TS1287; NOT run on real Postgres).** Admin routes `PATCH /api/v1/admin/users/:address/role` (admin only) and `GET /api/v1/admin/users` (admin, staff); `admin` never assignable; audit rows in append-only `app.audit_log`; target sessions revoked on role change; loadSession degrades to anonymous; expired sessions cleaned on login. USER-ACTION after review/commit: `docker compose exec -T api npm run migrate` (expect 001-005), `npm run migrate:status` (0 pending), `docker compose restart api`, GET /ready ok. The role route is only reachable from a frontend with an admin session (no UI yet), so confirm via migrate status and /ready.

**WS-06.2w RUNTIME-VERIFIED by the user 2026-11-06 (not verified by Claude):** wallet sign-in works end to end with the frontend (WS-06.3w), `ADMIN_WALLETS` wallet gets role admin, session persists after reload, other wallets are investor, CORS fine. USER-ACTION after WS-06.7w review/commit: `docker compose exec -T api npm run migrate` (expect 001-005 applied).

**USER-CONFIRMED 2026-11-06 (not verified by Claude; `.env*` not read):** migration 004 applied (`migrate:status` shows 001-004 applied) and `ADMIN_WALLETS` configured in the api env file. Whether the api was restarted after setting `ADMIN_WALLETS` is NOT stated: restart it (`docker compose restart api`) before checking that the admin wallet gets the `admin` role.

**User steps after review:** commit; the API reloads via tsx watch (or `docker compose restart api`); then `Invoke-RestMethod http://localhost:3001/ready` (expect success true), `Invoke-RestMethod "http://localhost:3001/api/v1/projects?limit=2"`, `Invoke-RestMethod "http://localhost:3001/api/projects?limit=2"`, `Invoke-RestMethod http://localhost:3001/api/v1/openapi.json`.

**Minor finding (WS-01.4):** `createApp` builds one profile limiter per mount (`/api/v1/projects` and `/api/projects`), so `POST /profile` has two separate 10/min buckets per client: the write limit is effectively doubled for an abuser. Fix: create one `createLimiter(...)` instance before the loop and pass it to both `createProjectRoutes` calls (one line). Not fixed (tracker does not edit source).  

---

## 1. Executive Summary

The `forgecapita-api` service provides the off-chain data layer, hybrid SQL joins with Ponder indexer tables, Paymaster gas debt recoupment signatures, and compliance auditing. 

Currently, basic server setup, PostgreSQL pool connections, startup profile upsertion, and unified on-chain/off-chain project retrieval are operational. However, **several critical runtime issues, missing endpoints, and empty stub files prevent the service from supporting the full architecture specified in `about.md`**.

---

## 2. Operational Features (Working)

- **Database Connection & Initialization:**
  - `src/db/pool.ts` connects cleanly to the Neon PostgreSQL instance with SSL.
  - (2026-11-05, WS-01.3a, awaiting review) The API no longer creates tables on boot: `src/index.ts` only verifies that every file in `migrations/` is applied (read-only) and exits 1 with `Run: npm run migrate` otherwise. Schema changes go through `npm run migrate` / `migrate:status` (`src/db/migrationRunner.ts`, `migrate.ts`; `app.schema_migrations` with checksums, advisory lock 727361001, one transaction per file). `001` creates schema `app`; `002` moves `public.startup_profiles` into `app` (or creates it), converts `created_at` to timestamptz, adds `updated_at` with trigger and 8 CHECK constraints. Ponder tables are read via `"<PONDER_SCHEMA>"."project"`. APPLIED to the real Neon database 2026-11-05 (user-reported, not verified by Claude): `migrate` applied 001 and 002, `migrate:status` 2 applied / 0 pending / 0 mismatched / 0 without file, `/health/db` ok after restart; `public.startup_profiles` had 0 rows before the move and `public` is now empty; Neon schemas: public, app, ponder, ponder_rpc_cache_1. A Render deployment needs `npm run migrate` as a pre-deploy step.
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
- `npx tsc --noEmit` reports 110 errors, all TS1295 (70) / TS1287 (40) (tracker re-ran 2026-11-05). Above the 91 baseline because WS-01.3a added imports: migrationRunner.ts 10, migrate.ts 6, index.ts 9, pool.ts 4, projectService.ts 5, env.ts 5; no other error kinds. Earlier: 91 (57 + 34; 89 before the WS-01.2 follow-up, +2 explained by one new import and one new export; 41 before WS-01.2; the new files add the same kind; nothing else is reported, so real type errors are hidden). CommonJS package vs NodeNext + verbatimModuleSyntax. tsx and jest work. User decision needed.

### A2. Findings from the WS-01.2 close (2026-11-05)
- FIXED 2026-11-05 (follow-up): library 4xx errors (e.g. `URIError` from a bad `%` escape) now return 400 with a generic message; `/health/db` logs via `toLoggableError`; `/health/` exempt from logging and limiter.
- Minor open: redaction covers one nesting level only; in production pino still emits `"stack":""`; the URIError test asserts the response only, not the log line (the handler logs the generic message, read-verified); pino-http `res.err` logging not exercised.
- Minor: `/health/db` logs the full pg error in production; redaction covers one nesting level; `/health/` with trailing slash is not exempt from the limiter or request log filter; preflights are not rate limited; express-rate-limit prints its own console warning if `X-Forwarded-For` arrives while `TRUST_PROXY=0`; LF files will be shown as CRLF-converted by git (cosmetic, no `.gitattributes`).
- Audit logging: `auditLogger` exists, nothing writes to it yet.

### A3. Findings from the WS-01.3a close (2026-11-05; nothing was run against a real Postgres)
- SQL read line by line: `$mig$` dollar quoting valid (each block closed, no nested quotes); `SET SCHEMA` carries the primary key index, defaults, constraints and triggers; `data_type = 'timestamp without time zone'` and the `table_schema = 'app'` filter are correct; `AT TIME ZONE 'UTC'` is right if the old session zone was UTC (Neon default; not verified); `ADD COLUMN IF NOT EXISTS updated_at ... NOT NULL DEFAULT now()` fills existing rows; `kyc_verified` backfill precedes SET NOT NULL; regexes use `~` in plain SQL, no escaping problem; URL and bio CHECKs are NULL-tolerant; the function is CREATE OR REPLACE and the trigger DROP IF EXISTS + CREATE, so 002 is re-runnable. The API zod limits match the CHECKs.
- RISK (medium-low): legacy rows written by the old API (it validated only required fields) may violate a CHECK (empty or over-long name/description, project_id with other characters, URLs over 2048). 002 would fail and roll back whole (nothing half-applied; runner prints SQLSTATE 23514 and the constraint name). Probably a tiny or empty table (v1 data discarded). Tradeoff for `NOT VALID`: the migration cannot fail on old data, but bad old rows stay and any later UPDATE/upsert of such a row fails until fixed, then `VALIDATE CONSTRAINT`. User decision; the optional Neon count check helps. 002 also assumes legacy `kyc_verified` and `shadow_wallet` columns exist (old boot code created them).
- Runner: bootstrap and each file run in their own BEGIN..COMMIT on ONE checked-out client with `pg_advisory_xact_lock` first, so it is safe on Neon's pooled endpoint (transaction mode); the direct string is still recommended. Pending set is re-checked under the lock. Errors surface only `Migration <file> failed (SQLSTATE, constraint)`; non-migration errors print a generic message in `migrate.ts`. Low: version/name/checksum are interpolated, not parameters (constrained to digits, `[a-z0-9_]` name, hex; quotes doubled); no `lock_timeout`/`statement_timeout`, so a blocked DDL waits indefinitely; no Pool 'error' handler in `migrate.ts`.
- Boot: `verifyMigrationsApplied` treats 42P01 as all pending and checks only pending files; checksum drift and unknown applied versions are NOT checked at boot (only by `migrate`/`migrate:status`). On failure it calls `process.exit(1)`; under `tsx watch` in the container the watcher stays alive waiting for a file change, so after `migrate` the user restarts the API. Non-Migration boot errors are logged via `toLoggableError` (a connection error message may name a host).
- projectService: `qualified()` quotes the schema; `PONDER_SCHEMA` is validated by `^[a-z_][a-z0-9_]{0,62}$` before interpolation; the table argument is a constant. The upsert keeps all 8 data columns; `updated_at` is set by the trigger. `StartupProfileRow` lacks `shadow_wallet`, `kyc_verified`, `updated_at` (cosmetic, 1.3b). The joins still use `p.id = s.project_id` without `chain_id` and may not match v2 indexer ids until WS-01.3b.
- Tests: 84 pass, 5 suites. migrationRunner tests use a recording fake pool and assert real order (BEGIN, lock, SQL, INSERT, COMMIT), rollback with no INSERT, concurrent skip, read-only verify, plus static checks of the real SQL files; projectService tests assert generated SQL strings and env regex cases. Not vacuous, but they never execute the SQL or regexes on Postgres, so the SQL is verified by reading only.

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
2. [ ] API-03 to API-05 and API-97 done and committed. WS-01.3a (API-06, API-07 first part) done, committed and migration applied 2026-11-05 (user-reported); API-98 README fix (bash vs sh, `npm run migrate:status`) open; WS-01.3b (API-07, API-08 partial) code done 2026-11-05, awaiting review and migration 003; next WS-01.4 (API-09, API-10).
3. [ ] `[USER-ACTION]` API-16 / API-17: email provider and admin bootstrap, then API-11 to API-22 accounts and roles.
4. [ ] API-30 to API-40 application, KYC, agreement and repo workflow.
5. [ ] After contracts v2 are deployed: API-70 to API-80 relayer.

(WS-01.3b BLOCKED section removed 2026-11-05: user confirmed committed, migration 003 applied, 3 applied / 0 pending, /health/db ok, sample requests work; user-reported, not verified by Claude.)

Note: the list response is now `{ items, total, limit, offset }` (was a bare array); the Postman collection in `postman/` still reflects the old shapes (update later).

## Change log

2026-11-07  WS-07.7  PENDING_TTL 2 h -> 7 days; reconcile in-flight tracking and awaited stop on shutdown before pool.end() (API-108); README 7 days; API-102 updated  - verified by: code read of reconcile.ts and index.ts; `docker compose exec -T api npm test` 10 suites 211/211; tsc only known TS1295/TS1287; package files unchanged; restart behaviour not verified.

2026-11-07  WS-07.6a hotfix  POST /launch-drafts 500 (`column "payload" does not exist`, 42703): CTE outer SELECTs in insertDraft/cancelPendingDraft now use OUTER_COLUMNS; backlog API-106 done, API-107 (real-Postgres smoke test) added  - verified by: code read of draftRepository.ts; api tests 211/211 per main session (not re-run); not yet re-run on real Postgres by the user. Lesson: mocked-pg tests do not prove SQL correctness.

2026-11-06  WS-07.6a  Launch drafts: migration 009, `/api/v1/launch-drafts` (create/attach/cancel/mine), reconcile job with advisory lock and 2 h pending expiry, wallet reservation in founderRepository/projectService/founderController; tests/launchDrafts.test.ts (21)  - verified by: code read, api tests 211/211 in docker, tsc noise only; not run on real Postgres.
2026-11-06  WS-07.5m  requestShadowWallet rejects 400 'Use a dedicated wallet, not your login wallet' when the address equals the user's login wallet (case-insensitive); +1 test in tests/founders.test.ts  - verified by: read founderService.ts, docker npm test 9 suites 189 pass, tsc known TS1287/TS1295 noise only; runtime NOT verified (needs `docker compose restart api`). Note: rule enforced only against the login wallet, not other founders' personal wallets
2026-11-06  WS-07.5a  Shadow wallet pool, migration 008, per-project binding via `shadowWalletId` on `POST /projects/profile` with launch-eligibility enforced (API-WS07-h ticked, API-38 partial); new API-WS07-p..u  - verified by: read migration 008, upsertProfile CTE, projectService binding flow; npm test 188/188 in docker, tsc known TS1295/TS1287 only, package.json unchanged; not run on real Postgres
2026-11-06  WS-07.2l  Agreement acceptance, shadow wallet request/approval, launch-eligibility, migration 007; API-WS07-d and API-34 ticked, API-33/38/39 partial; new API-WS07-i..o  - verified by: read migration/agreement/repository/service/routes, npm test 178/178 in docker, tsc known errors only; not run on real Postgres
2026-11-06  WS-07.1l  Founder applications + staff review/KYC attestation, migration 006; API-WS07-a/b/c ticked; new API-WS07-e/f/g  - verified by: read migration/repository/service/routes/schemas, npm test 157/157 in container, tsc only TS1295/TS1287, package.json unchanged; Postgres runtime not verified
2026-11-06  WS-07.1l  Selected (planning only): lean WS-07 plan, new backlog items API-WS07-a..d; no code changed  - verified by: n/a (docs only)
2026-11-06  WS-06.7w  User reports migration 005 applied and step reviewed/committed  - verified by: user-reported, not verified

2026-11-06  WS-06.7w  Admin role assignment + GET users, migration 005 audit_log (append-only), session revocation, API-WS06-a/b done; API-21 partial  - verified by: read migration/repo/service/routes/middleware, npm test 145/145 in container, tsc filtered; Postgres runtime not verified

2026-11-06  WS-06.2w  Runtime verification recorded (sign-in, admin via ADMIN_WALLETS, session persistence, CORS); WS-06.7w selected  - verified by: USER REPORT only, not verified by Claude

2026-11-05  WS-01.4  Follow-up: profile-write limiter now created once (`profileLimiter`) and shared by /api/v1/projects and /api/projects (fixes doubled 10/min limit)  - verified by: read app.ts lines 104-109; 117/117 tests run by main session (`docker compose exec -T api npm test`), not re-run by tracker

2026-11-05  WS-01.4  API-09 ticked (/ready: DB + migrations, generic 503; indexer reachability deferred); API-10 partial (/api/v1 + deprecated /api/projects alias, hand-written openapi.json non-production only; /api/docs, generated doc, drift check, alias removal deferred); API-98 ticked (README)  - verified by: reading app.ts, healthController.ts, openapi.ts (routes/query names match projectSchemas, error envelope matches errorHandler), README, 6 new tests (assert real status/body, not vacuous); `docker compose exec -T api npm test` 117/117; `npx tsc --noEmit` 129 errors, only TS1295 (77) / TS1287 (52) (API-96). NOT verified: live server or Postgres; production 404 for openapi.json; /ready rate-limit and log exemption (regex read only); alias POST /profile not tested

2026-11-05  WS-01.3b  API-07 ticked; API-08 partial (chain_id, category, pagination, search, filters, sort done; application_status/repo_* deferred to API-30/API-35, owner to WS-06); API-98 README part partial (migrate commands present, sh/bash and ponder_rpc_cache notes missing); migration 003, projectRepository/Service/Schemas, README; no shadow_wallet/kyc_verified in any response  - verified by: reading all files, `docker compose exec -T api npm test` 111/111 (5 suites), `npx tsc --noEmit` 123 errors all TS1295 (73) / TS1287 (50) (API-96); NOT verified: SQL on Postgres, migration 003 not run, Ponder column names against the live schema (checked against ponder.schema.ts only)

2026-11-05  WS-01.3a migration applied  API-06 fully ticked (finding 1 resolved: 0 legacy rows; findings 2-5 minor open); API-07 stays open (chain_id join, WS-01.3b); new API-98 (README: container has only sh, use `docker compose exec api sh` or `exec -T api npm run migrate`; `npm run migrate:status`)  - verified by: USER REPORT only (migrate output "Migrations complete: 2 applied", migrate:status "2 applied, 0 pending, 0 mismatched, 0 without file", /health/db ok, Neon schemas public (empty)/app/ponder/ponder_rpc_cache_1); not verified by Claude (no DB access by design)

2026-11-05  WS-01.3a  API-06 ticked as code-done (real DB application NOT verified); API-07 first part done, item stays open (chain_id join -> WS-01.3b); API-96 count now 110 (70 TS1295 + 40 TS1287); new migrations/001, 002, src/db/migrationRunner.ts, migrate.ts; pool.ts `qualified()`, env.ts `PONDER_SCHEMA`, index.ts boot verify, projectService qualification, README, .env.example; findings in 3.A3  - verified by: reading all listed files, `docker compose exec -T api npm test` 84/84 (5 suites), `docker compose exec -T api npx tsc --noEmit` 110 errors all TS1295/TS1287 with per-file counts; NOT verified: any SQL on a real Postgres, `npm run migrate` (never run by tracker), boot against Neon
2026-11-05  WS-01.2 follow-up  errorHandler honours 4xx only with expose===true or URIError (generic messages), toLoggableError, /health/ exemption, .gitattributes (`* text=auto eol=lf`; user runs `git add --renormalize .`, existing files may show as modified once); tests 44; tsc 91 (+2 = new import/export, API-96)  - verified by: reading errorHandler/healthController/app diffs, `docker compose exec -T api npm test` 44/44, `npx tsc --noEmit` 91 all TS1295/TS1287 listed per file; NOT verified: live production log shape
2026-11-05  WS-01.2  API-03, API-04, API-05, API-97 ticked (audit logger created but unused); new `app.ts`, `errors.ts`, `logger.ts`, `rateLimit.ts`, `requestId.ts`, `validate.ts`, `schemas/`; `index.ts` graceful shutdown; helmet 8.3.0, express-rate-limit 8.7.3, pino 10.4.0, pino-http 11.0.0, pino-pretty 13.2.0 added (lockfile checked); findings: 400-vs-500 for library 4xx, minor logging/limiter items (see 3.A2); API-96 stays open (tsc 89 errors, all TS1295/TS1287)  - verified by: reading all src files and tests, `docker compose exec api npm test` 3 suites 39/39, `npx tsc --noEmit` 89 errors all TS1295/TS1287, grep: only two console.error in env.ts, no req.body logging; NOT verified: real DB boot, Render proxy hops, browser CORS, shutdown signals, pino-pretty

2026-11-01  re-plan  v2-first re-plan approved by the user; no API step changes (WS-01.2 onward unchanged); docs only  - verified by: not applicable (no code touched)
2026-11-01  WS-01.1  API-01 paymaster removed; API-02 zod env config (src/config/env.ts), zod added, jest setupEnv; new backlog API-96 (tsc TS1295 tooling, predates step), API-97 (dotenv log line)  - verified by: npm test 8/8, grep for paymaster/TREASURY_PRIVATE_KEY clean, negative boots (bad URL, PORT=0, bad NODE_ENV) exit 1; npx tsc --noEmit still 41 TS1295/TS1287 errors (pre-existing); "required" branch and valid-env boot against a real DB not verified by tracker
