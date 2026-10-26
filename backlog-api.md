# ForgeCapita API — Development Backlog

This backlog tracks the off-chain Express.js microservice (`forgecapita-api`), responsible for managing startup off-chain metadata, executing SQL joins with Ponder's indexed blockchain data, facilitating Paymaster gas recoupment signatures, executing Secret Shopper revenue auditing, and enforcing UI-gated project launches.

> **Legend:**
> - `[x]` Completed
> - `[ ]` Pending
> - `[USER-ACTION]` Requires manual action or credential provisioning from the repository owner/user.

---

## Phase 1: Mandatory Core Infrastructure

### Database & Core Services
- [x] Scaffold Express.js backend with basic health checks and global error handling.
- [x] Configure PostgreSQL connection pool (`pg.Pool`) connecting to Neon DB with SSL.
- [x] Create the initial `startup_profiles` table to store off-chain metadata (`name`, `description`, `pitch_deck_url`, `founder_bio`, `website_url`).
- [x] Add `shadow_wallet` and `kyc_verified` columns to `startup_profiles` schema.
- [ ] Add `status` column (`VARCHAR NOT NULL DEFAULT 'PENDING'`) to `startup_profiles` schema for UI gating ('PENDING', 'APPROVED', 'REJECTED', 'ROGUE').
- [ ] Replace plain URL inputs with `multer` multipart file upload handling for project logos.
- [ ] `[USER-ACTION]` Set up Cloud Storage bucket (AWS S3 or Supabase Storage) and provide credentials in `.env` (`S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` or Supabase equivalents).
- [ ] Implement cloud storage upload utility to stream uploaded logo files and persist CDN paths to `startup_profiles.logo_url`.

### Paymaster & Gas Recoupment Infrastructure
- [x] Implement EIP-712/ECDSA message hashing and signature generation logic in `paymasterService.ts` matching `MilestoneEscrow.sol` verification (`keccak256(abi.encodePacked(address, milestoneIndex, chainId, gasDebt))`).
- [ ] **Critical Fix:** Populate and wire `src/routes/paymasterRoutes.ts` (currently an empty 0-byte file) to route `POST /api/paymaster` to `signMilestoneExecution`.
- [ ] `[USER-ACTION]` Provide funded Treasury private key in `.env` (`TREASURY_PRIVATE_KEY`) matching `forgeCapitaTreasury` on-chain address for signing Paymaster payloads.
- [ ] Implement database-backed gas debt tracking table (`gas_debt_records`) to calculate real accumulated gas debt instead of blindly trusting client-supplied values.
- [ ] Build `/api/projects/shadow-wallet` endpoint allowing KYC-approved founders to register or rotate their fiat-to-crypto shadow wallet.

### Compliance & Auditing (Secret Shopper Service)
- [ ] `[USER-ACTION]` Create Etherscan account, generate API key, and configure `ETHERSCAN_API_KEY` in `.env`.
- [ ] `[USER-ACTION]` Create BscScan account, generate API key, and configure `BSCSCAN_API_KEY` in `.env`.
- [ ] Implement Etherscan/BscScan REST client in `auditService.ts` to poll incoming ETH/BNB/ERC-20 transfers for registered `shadow_wallet` addresses.
- [ ] Build reconciliation logic comparing off-chain Shadow Wallet inflows against on-chain `RevenueRouter` deposits (`PaymentReceived` events indexed by Ponder).
- [ ] Create an `audit_discrepancies` table to record flagged startups whose off-chain revenue exceeds routed on-chain payments beyond tolerance thresholds.
- [ ] Wire `startRevenueAuditCron()` into server bootstrap in `src/index.ts`.

### Emergency & Governance Mechanics
- [ ] Build internal, highly restricted admin endpoint (`POST /api/admin/emergency-shutdown/:projectId`) to trigger on-chain `emergencyShutdown()` via `TREASURY_PRIVATE_KEY` when exit scams or rogue deployments are detected.
- [ ] Build endpoint to monitor Hostile Takeover events, updating developer ownership in `startup_profiles` when `acceptDeveloperRole()` is executed on-chain.

---

## Phase 2: Production Features & Dashboards

### Security & Authentication
- [ ] `[USER-ACTION]` Define and set `JWT_SECRET` in `.env`.
- [ ] Implement Sign-In with Ethereum (SIWE) verification (`POST /api/auth/verify`) using `siwe` and issue signed JWTs.
- [ ] Create JWT authentication middleware (`requireAuth`) validating caller wallet addresses against project developer addresses or the platform Treasury.
- [ ] Implement rate limiting (`express-rate-limit`) on public endpoints (`/api/projects/profile`, `/api/paymaster`, `/api/auth/*`).

### Project Approval Workflow (UI Gating & Rogue Mitigation)
- [ ] Build `POST /api/projects/apply` for founders to register off-chain startup applications with initial status `'PENDING'`.
- [ ] Build `PATCH /api/admin/projects/:projectId/status` for platform admins to mark profiles as `'APPROVED'` or `'REJECTED'`.
- [ ] Build `GET /api/projects/status/:walletAddress` allowing the frontend to verify if a founder is cleared to deploy.
- [ ] Build background synchronization service: Cross-reference on-chain `project` rows indexed by Ponder against `startup_profiles`. If an escrow contract was launched by a founder with `status != 'APPROVED'`, automatically mark as `'ROGUE'` and notify admins.

### Admin Dashboard API
- [ ] Build `GET /api/admin/projects/pending` to retrieve all pending founder applications awaiting vetting.
- [ ] Build `GET /api/admin/projects/rogue` to fetch contracts deployed without UI pre-approval.
- [ ] Build `PATCH /api/admin/founders/:address/kyc` to update `kyc_verified` flags after manual identity verification.
- [ ] Build `GET /api/admin/analytics` returning platform aggregates (total funds raised, active audits, flagged projects, treasury fees collected).

### Founder Dashboard API
- [ ] Build `GET /api/founder/projects/:projectId` returning founder-specific metrics (accumulated gas debt, pending creator funds from `RevenueRouter`, milestone execution status).
- [ ] Build `PATCH /api/founder/projects/:projectId` to allow authenticated founders to update descriptions, pitch decks, and website URLs.
- [ ] Build `GET /api/founder/revenue-report/:projectId` displaying on-chain vs. shadow-wallet revenue audit history.

### Investor Dashboard API
- [ ] Build `GET /api/investor/portfolio/:walletAddress` combining on-chain token balances, staked positions, and off-chain startup metadata.
- [ ] Build `GET /api/investor/dividends/:walletAddress` returning historical yield claims across all supported projects.
- [ ] Build `GET /api/investor/votes/:walletAddress` returning active milestone votes where the investor holds eligible voting weight.

---

## Phase 3: DevOps & Quality Assurance
- [x] Create base `Dockerfile` for Node.js containerization.
- [ ] Update `Dockerfile` to multi-stage build (build TypeScript, run production bundle without devDependencies).
- [ ] Configure structured logging (Winston or Pino) with JSON log formatting for audit logs and error tracking.
- [ ] Write integration test suite using `jest` and `supertest` covering:
  - `/health` connectivity
  - `/api/projects/profile` upsertion
  - Unified SQL join endpoints (`/api/projects`, `/api/projects/:id`)
  - `/api/paymaster` signature verification
- [ ] `[USER-ACTION]` Set up GitHub Actions CI workflow to run linter, typecheck, and Jest tests on pull requests.