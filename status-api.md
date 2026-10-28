# ForgeCapita API — Service Status & Technical Health Report

**Service:** `forgecapita-api` (Off-Chain Microservice)  
**Runtime:** Node.js 22 / Express.js / TypeScript  
**Database:** Neon PostgreSQL (Shared with Ponder Indexer)  
**Port:** 3001  
**Last Updated:** 2026-10-28 (plan revised; code unchanged since the previous report)  

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
- **Paymaster Signature Logic:**
  - `src/services/paymasterService.ts` contains the cryptographic logic (`ethers.solidityPackedKeccak256` and ECDSA signing) matching `MilestoneEscrow.sol` verification.

---

## 3. Critical Issues & Immediate Blockers

### A. Broken Paymaster Route (`src/routes/paymasterRoutes.ts`)
- **Status:** **CRITICAL BLOCKER** 🚨
- **Problem:** `src/routes/paymasterRoutes.ts` is completely empty (0 bytes). However, `src/index.ts` imports it (`import paymasterRoutes from "./routes/paymasterRoutes.js"`) and attempts to mount it via `app.use("/api/paymaster", paymasterRoutes)`.
- **Impact:** Any attempt to start the server or call `/api/paymaster` fails or throws runtime routing errors.
- **Remedy (revised 2026-10-28):** Do not repair the treasury-signature Paymaster. Remove the import and mount (backlog API-01); it is replaced by the gasless relayer (API-70 to API-80) once contracts v2 exist.

### B. Missing `status` Column in `startup_profiles`
- **Status:** **HIGH PRIORITY** ⚠️
- **Problem:** `src/db/pool.ts` creates `startup_profiles` with `shadow_wallet` and `kyc_verified`, but lacks the `status VARCHAR` column (`'PENDING'`, `'APPROVED'`, `'REJECTED'`, `'ROGUE'`).
- **Impact:** The architectural decision to enforce **Pre-Launch UI Gating** (Section 3.B of `about.md`) cannot be implemented because there is no column tracking whether an admin has approved a founder's submission.
- **Remedy Required:** Alter table or update initialization script to include `status VARCHAR NOT NULL DEFAULT 'PENDING'`.

### C. Missing Environment Variables & Configuration
- **Status:** **CONFIG BLOCKER** ⚠️
- **Problem:** `.env.example` only lists `DATABASE_URL` and `PORT`. The following essential variables are missing:
  1. `TREASURY_PRIVATE_KEY`: Required by `paymasterService.ts` to sign gas debt payloads and trigger emergency shutdowns.
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

### B. Untrusted Gas Debt in Paymaster Controller
- `src/controllers/paymasterController.ts` accepts `gasDebt` directly from `req.body` and signs it without verifying against off-chain accumulated subsidization records.
- Developers could manipulate `gasDebt` in the request to divert milestone release funds. A database table tracking gas subsidies is needed to compute verified debt.

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

1. [ ] API-01 remove the broken Paymaster mount so the server boots cleanly.
2. [ ] API-02 to API-10 hardening, migrations (API tables in schema `app`), pagination, readiness.
3. [ ] `[USER-ACTION]` API-16 / API-17: email provider and admin bootstrap, then API-11 to API-22 accounts and roles.
4. [ ] API-30 to API-40 application, KYC, agreement and repo workflow.
5. [ ] After contracts v2 are deployed: API-70 to API-80 relayer.
