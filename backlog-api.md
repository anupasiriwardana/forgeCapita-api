# ForgeCapita API — Development Backlog

This backlog tracks the off-chain Express.js service (`forgecapita-api`): accounts and roles, founder applications and manual KYC, the Revenue Share Agreement, repo provisioning, revenue-integrity auditing (shadow wallet reconciliation and Secret Shopper), complaints and takeover workflow, the **gasless relayer**, and the unified SQL read model over Ponder's tables.

> **Legend:**
> - `[x]` Completed
> - `[ ]` Pending
> - `[USER-ACTION]` Requires manual action or credential provisioning from the repository owner/user.
> - `[BLOCKED-BY]` Cannot start until another backlog item is done.
> - `[DEFERRED]` Planned, not scheduled.

Item IDs (`API-xx`) are referenced from `ROADMAP.md`. Plan revised 2026-10-28.

## Decisions that shape this backlog

- **Accounts:** email + password (argon2id), email verification, password reset, lockout, server-side sessions in httpOnly cookies with CSRF protection. A wallet is *linked* to an account by signing a message (Sign-In with Ethereum style); one wallet per account. SIWE is no longer the login method.
- **Roles:** `investor`, `founder`, `staff`, `admin`. There is one admin and one treasury wallet (the admin's wallet). TOTP 2FA is mandatory for `staff` and `admin`.
- **Treasury key never lives on the server.** Emergency shutdown, freeze and takeover transactions are signed by the admin in the browser wallet. The API holds only the **relayer** key.
- **Gas model:** option A for launch = users pay their own gas on invest / claim yield / refund / create / revenue / unstake; **claim tokens, stake, vote and execute milestone are gasless** through the relayer (needs contracts v2, see `backlog-contracts.md`). The old treasury-signature "Paymaster" route is removed, not repaired.
- **KYC is manual** (staff review of uploaded documents). **Repo hosts: GitHub and GitLab.** **Revenue audit includes allow-listed ERC-20 tokens** converted to USD.

## Role & permission matrix

(Reconstructed from the planning discussion; review before implementing API-20.)

| Capability | Investor | Founder | Staff | Admin |
|---|---|---|---|---|
| Browse, invest, vote, claim, file complaints | ✅ | — | — | — |
| Submit / edit own application, agreement, shadow wallet request | — | ✅ | — | — |
| Review applications (approve / reject / request changes) | — | — | ✅ | ✅ |
| Manual KYC review | — | — | ✅ | ✅ |
| Provision repos, approve shadow-wallet changes | — | — | ✅ | ✅ |
| Handle complaints (triage, respond, close) | — | — | ✅ | ✅ |
| View compliance cases / Risk Center | — | own project | read + notes | ✅ |
| Freeze / unfreeze milestones | — | — | — | ✅ |
| Emergency shutdown | — | — | — | ✅ |
| Takeover: prepare case, run signalling vote | — | — | ✅ | ✅ |
| Takeover: execute `proposeNewDeveloper`, repo lockout | — | — | — | ✅ |
| Manage staff accounts, system settings (tolerance, token allow-list, relayer limits) | — | — | — | ✅ |
| View full audit log | — | — | own actions | ✅ |

---

## Phase 0: Existing foundation

- [x] Scaffold Express.js backend with basic health checks and global error handling.
- [x] Configure PostgreSQL connection pool (`pg.Pool`) connecting to Neon DB with SSL.
- [x] Create `startup_profiles` (`name`, `description`, `pitch_deck_url`, `founder_bio`, `website_url`, `logo_url`) with `shadow_wallet` and `kyc_verified` columns.
- [x] `GET /api/projects`, `GET /api/projects/:projectId` (LEFT JOIN of Ponder `project` with `startup_profiles`), `POST /api/projects/profile` upsert, `GET /health`.
- [x] Base `Dockerfile`.

## Phase 1: Foundation & hardening

- [ ] **API-01** Remove the broken Paymaster wiring: delete the empty `src/routes/paymasterRoutes.ts` import/mount (it breaks boot), and retire `paymasterService.ts` / `paymasterController.ts` / `TREASURY_PRIVATE_KEY` usage. Replaced by the relayer (API-70+).
- [ ] **API-02** Environment validation with zod at boot (fail fast, no secrets in logs); keep `.env.example` complete. `[USER-ACTION]` populate `.env` values as each item requires them.
- [ ] **API-03** Security middleware: `helmet`, CORS allow-list from env, JSON body size limit, global + per-route rate limits (`express-rate-limit`), request IDs.
- [ ] **API-04** Input validation with zod on every route; uniform error format; no stack traces in production responses.
- [ ] **API-05** Structured logging (pino) with redaction of passwords, tokens, cookies, signatures and PII; request logging; audit logging separate from app logs.
- [ ] **API-06** Migrations: adopt a migration tool (`node-pg-migrate` or equivalent), baseline migration for `startup_profiles`, remove `CREATE TABLE IF NOT EXISTS` from boot. API tables live in their own schema (`app`); Ponder data is read through a configurable schema name (`PONDER_SCHEMA`), not hard-coded `public`.
- [ ] **API-07** Replace unqualified `FROM project` joins with the configured Ponder schema; add `chain_id` to joins once the indexer exposes composite keys (IDX-01).
- [ ] **API-08** `startup_profiles` changes: `category`, `chain_id`, `application_status`, `repo_provider`, `repo_url`, `created_at`/`updated_at`; pagination (`limit`/`cursor`), search, category/chain/status filters, allow-listed sort fields.
- [ ] **API-09** Health + readiness endpoints (`/health` liveness, `/ready` checks DB and indexer reachability); graceful shutdown.
- [ ] **API-10** Versioned routes (`/api/v1`) and generated OpenAPI document served at `/api/docs` in non-production.

## Phase 2: Accounts, sessions & roles

- [ ] **API-11** Tables: `users` (email unique, `password_hash`, `role`, `email_verified_at`, `totp_secret_enc`, `failed_logins`, `locked_until`), `sessions`, `email_tokens` (verify / reset, hashed, expiring, single use).
- [ ] **API-12** Sign-up (investor or founder), email verification, login, logout, logout-all, change password, password reset. argon2id hashing, constant-time compare, generic error messages, lockout with backoff, breach-safe password rules.
- [ ] **API-13** Server-side sessions: random opaque ID, httpOnly + Secure + SameSite=Lax cookie, rotation on login and privilege change, idle + absolute timeout, CSRF token (double submit or synchronizer) on state-changing routes.
- [ ] **API-14** TOTP 2FA enrolment and verification with recovery codes; **mandatory for `staff` and `admin`** (login blocked until enrolled).
- [ ] **API-15** Wallet linking: server issues a nonce + message (domain, chain, nonce, expiry), user signs in MetaMask, API verifies the signature and stores `wallet_address` (checksummed, unique, one per account). Re-link requires password + staff/admin approval for founders with live projects. Smart-contract wallets via ERC-1271 `[DEFERRED]`.
- [ ] **API-16** `[USER-ACTION]` Choose and configure an email provider (Resend, Postmark or SES), verify the sending domain, provide `EMAIL_API_KEY`, `EMAIL_FROM`, `APP_BASE_URL`, `SESSION_SECRET` in `.env`. Dev fallback: log emails to console in non-production only.
- [ ] **API-17** `[USER-ACTION]` Admin bootstrap: run a one-time seed script with `ADMIN_EMAIL`; admin sets the password through the reset link and enrols TOTP; link the treasury wallet (must equal the on-chain treasury). The script refuses to run if an admin already exists.
- [ ] **API-18** Staff management (admin only): invite staff by email, assign / revoke role, force 2FA enrolment, deactivate; all changes audit-logged.
- [ ] **API-19** `requireAuth`, `requireRole(...)`, `requireOwnership(resource)` middleware. Ownership is derived from the session user, never from client-supplied wallet or user IDs.
- [ ] **API-20** Apply RBAC to every existing and new route per the matrix above; fix `POST /api/projects/profile` so a founder can only modify their own application / project.
- [ ] **API-21** Append-only `audit_log` (actor, role, action, target, before/after summary, IP, user agent, time) written for every privileged action; admin read endpoint with filters.
- [ ] **API-22** In-app notifications table + email templates (application changes requested, approved / rejected, KYC result, compliance warning, complaint updates); notification preferences.

## Phase 3: Founder application, manual KYC, agreement & repo

### Application workflow
- [ ] **API-30** `POST /api/v1/applications` (founder). State machine: `DRAFT → PENDING → CHANGES_REQUESTED ↔ PENDING → APPROVED | REJECTED`, plus `ROGUE` (set by sync). Every transition recorded in `application_history` (actor, from, to, note, time). Founders can edit only in `DRAFT` / `CHANGES_REQUESTED`.
- [ ] **API-31** Staff/admin review endpoints: queue (filters, pagination), detail, request changes (requires note), approve, reject (requires reason). Approval requires KYC approved + agreement accepted + repo provisioned (API-32 to API-37).
- [ ] **API-32** Manual KYC: founder uploads ID document + proof of address (private bucket, API-85); `kyc_submissions` (status `SUBMITTED / APPROVED / REJECTED / EXPIRED`, reviewer, notes). Staff review via short-lived signed URLs; every view audit-logged. PII encrypted at rest, retention policy documented, deletion on request flow. `kyc_verified` is derived from an approved submission.
- [ ] **API-33** Revenue Share Agreement: `agreement_templates` (versioned text, hash), `agreement_acceptances` (user, project, template version, text hash, typed full name, wallet signature over the hash, IP, user agent, time). "I agree" step requires a fresh wallet signature so the identity maps to the wallet.
- [ ] **API-34** Draft the agreement text `legal/revenue-share-agreement-v0.1.md` covering: revenue routing duty, shadow wallet declaration, audit and Secret Shopper consent, repo ownership and access rules, remedies (freeze, shutdown, takeover, repo lockout), and founder-exit consequences. Banner: *"Draft, not legal advice — to be reviewed by a qualified lawyer before production use."* `[USER-ACTION]` manual review of the text later.
- [ ] **API-35** Repo provisioning: provider abstraction for **GitHub and GitLab** (founder picks one). ForgeCapita creates the repository under its own organisation / group, grants the founder write access via invitation, returns the link. Branch protection on the default branch; ForgeCapita keeps owner rights. Store provider, repo ID, URL, collaborator IDs.
- [ ] **API-36** `[USER-ACTION]` Create the GitHub organisation + GitHub App (or fine-grained token) and the GitLab group + access token with minimum scopes; provide `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_ORG`, `GITLAB_TOKEN`, `GITLAB_GROUP_ID` in `.env`.
- [ ] **API-37** Repo lifecycle: webhook receiver (signature-verified) to detect visibility changes / deletion / collaborator changes; admin action "lock out founder" (revoke access) used in takeover; handover of access to a new developer.
- [ ] **API-38** Shadow wallet registration: founder requests a wallet (checksummed, per chain); staff/admin approve; every change is versioned in `shadow_wallet_history` and takes effect after a cooldown. The approved wallet is **public** (investor-facing endpoint) and cannot be edited directly.
- [ ] **API-39** Pre-launch gating endpoint `GET /api/v1/applications/mine/launch-eligibility` returning whether the founder may deploy (status `APPROVED`, KYC, agreement, repo, shadow wallet all satisfied) and the approved metadata hash to display.
- [ ] **API-40** Rogue-deployment sync job: compare indexed launches (factory `ProjectLaunched`, launcher address from IDX-08) against approved applications and linked wallets; mark unmatched launches `ROGUE`, open a compliance case and notify staff/admin.

- [ ] **API-41** Minimum funding goal per chain: store the goal and chain on the application and reject (or request changes on) applications below the configured minimum for that chain (Arbitrum Sepolia in ETH, BSC Testnet in BNB). The minimum is an admin-adjustable setting so it can be recalculated from measured gas (contracts v2 design section 13). The frontend shows the same value, but this check cannot be bypassed from the browser.

## Phase 4: Revenue integrity & compliance

- [ ] **API-45** `[USER-ACTION]` Create an Etherscan account and API key (a single Etherscan V2 key is believed to cover BSC as well — verify at build time; otherwise also create a BscScan key). Provide `ETHERSCAN_API_KEY` (and `BSCSCAN_API_KEY` if needed) in `.env`.
- [ ] **API-46** `[USER-ACTION]` Pick a price source (CoinGecko free tier suggested) and provide `PRICE_API_KEY`.
- [ ] **API-47** Explorer client: rate-limited, retrying, paginated fetch of native transfers and ERC-20 transfers (token-transfer endpoint) into each approved shadow wallet; idempotent storage in `inflow_records` (chain, tx, log index, token, amount, time).
- [ ] **API-48** `allowed_tokens` per chain (admin-managed): symbol, contract, decimals, USD handling (stablecoins counted at $1, others priced). Mock token on testnets for testing.
- [ ] **API-49** `price_snapshots` and USD conversion for native coin and allow-listed tokens at transfer time (daily granularity is enough).
- [ ] **API-50** Reconciliation job: 30-day rolling window per project; observed inflow (USD) vs deposits to `RevenueRouter` (`PaymentReceived`, converted to USD at deposit time). Flag only when deposits are **below** observed inflow by more than the tolerance (default 4%, admin-adjustable setting). Founders convert stablecoins to ETH/BNB before depositing because the router accepts native coin only.
- [ ] **API-51** Compliance case state machine: `OK → WARNED → ESCALATED → RESOLVED | SHUTDOWN`. `WARNED` notifies the founder; `ESCALATED` after 14 days unresolved notifies admin; resolution notes and evidence stored; transitions audit-logged.
- [ ] **API-52** Freeze coupling: when a case is `ESCALATED`, the admin may freeze milestones (on-chain `freezeMilestones`, signed in the browser). The API tracks freeze state from the indexer and shows it; it never sends the freeze itself.
- [ ] **API-53** Public transparency endpoint per project: approved shadow wallet (permanent), compliance state, last reconciliation result and date, deposits vs observed totals, freeze flag. No PII.
- [ ] **API-54** Secret Shopper worker (separate process / container): weekly Playwright crawl of the founder's checkout from the registered product URL; verifies the payment destination matches the registered shadow wallet; stores evidence (screenshots in private storage); mismatch opens a compliance case. SSRF protection: allow only registered public domains, block private / link-local / metadata IP ranges, resolve-and-pin DNS, redirect limits, timeouts, no credentials, isolated network. `[DEFERRED]` until reconciliation (API-50) is stable.
- [ ] **API-55** Wire the cron jobs (reconciliation, rogue sync, gas sampling) into `src/index.ts` with overlap locks (Postgres advisory locks) so multiple instances do not double-run.

## Phase 5: Complaints & takeover

- [ ] **API-60** Investor complaints: `complaints` (project, investor, category, body, attachments, status `OPEN / IN_REVIEW / RESOLVED / ESCALATED`, assignee), message thread, rate limits, evidence upload. Staff triage and respond; escalate to admin; investor notifications.
- [ ] **API-61** Complaint-to-case link: staff can attach a complaint to a compliance case; repeated complaints on a project surface in the Risk Center.
- [ ] **API-62** Takeover workflow: `takeover_cases` (project, reason, evidence, status), candidate developer (must have an approved founder profile + KYC + agreement), **off-chain signalling vote** using staked balances snapshotted from the indexer at a block, quorum rules, voting window. Admin executes `proposeNewDeveloper` from the browser wallet; the API tracks `developer_change` events (IDX-07) until the new developer accepts. Repo handover (API-37).
- [ ] **API-63** Emergency shutdown support endpoints (no key on server): list shutdown candidates with evidence summary, record the admin's decision and tx hash, verify on chain via the indexer. The transaction itself is signed by the admin in the frontend.

## Phase 6: Gas oracle & relayer (gasless actions)

`[BLOCKED-BY]` contracts v2 deployed (CON-04.2) for everything that submits transactions. Gas oracle and queue scaffolding may start earlier.

- [ ] **API-70** `[USER-ACTION]` Generate a dedicated relayer wallet (not the treasury), provide `RELAYER_PRIVATE_KEY` in `.env` (never in chat or logs), and fund it on Arbitrum Sepolia and BSC Testnet from faucets. The treasury allow-lists it on-chain (CON-04.3).
- [ ] **API-71** Gas oracle: sample each chain every 5 minutes (`eth_gasPrice` / fee history) into `gas_samples`; 24-hour average; `GET /api/v1/gas/:chainId` returns `{ current, avg24h, ratio, status: NORMAL | HIGH, estimatedCostUsd }`.
- [ ] **API-72** Request intake: `POST /api/v1/relay/{claim|stake|vote}` accepts the request (claim: no signature, the logged-in account is authenticated; stake: ERC-2612 permit; vote: EIP-712 `Vote` signature). Milestone execution is not user-submitted; the auto-execute worker (API-78) handles it (contracts v2 design, section 4.3). Validates schema, deadline, signature recovery, nonce against chain, signer = the session user's linked wallet, and action eligibility by reading the chain (e.g. stake balance for voting, vote open, milestone executable, not frozen). Simulates with `eth_call` before queueing. Rejects obvious abuse early.
- [ ] **API-73** Queue: `relay_requests` (kind, chain, project, signer, payload, signature hash, status `QUEUED / SENDING / SENT / CONFIRMED / FAILED / EXPIRED`, `send_by`, created / sent / confirmed times, tx hash, gas used, cost). Idempotent by signature hash.
- [ ] **API-74** Send policy worker: submit when current gas ≤ 24h average; otherwise wait until `send_by = min(created + 6h, deadline, vote end − safety margin)`; at `send_by` submit regardless unless the circuit breaker is open. "Send now" flag only for requests close to expiry.
- [ ] **API-75** Transaction management: per-chain nonce manager, gas price bump + replacement for stuck transactions, receipt tracking, reorg-safe confirmation depth, retry classification (retryable vs permanent revert).
- [ ] **API-76** Abuse controls: per-wallet and per-project daily limits, per-action cost cap check against the contract's cap, global spend ceiling per day, circuit breaker (pause relaying) when gas ratio or relayer spend exceeds thresholds; admin override.
- [ ] **API-77** Relayer balance monitor: alert (email + Risk Center) below a configurable threshold; project-level gas spend view (spent vs 5% budget vs overflow) fed by indexer `SponsoredGas` / `GasDebtRecovered` events (IDX-10).
- [ ] **API-78** Auto-execute: worker watches indexed milestones; when a milestone is executable and not frozen, queue an `execute` request (the contract allows anyone once conditions are met), subject to the same gas policy.
- [ ] **API-79** `relay_log` audit (who, what, signature hash, tx, cost) and admin report; no private data in logs.
- [ ] **API-80** `[DEFERRED]` Move the relayer key to a managed signer / KMS; key rotation runbook.

## Phase 7: Dashboards (API side)

- [ ] **API-81** Admin / staff: applications queue, KYC queue, complaints queue, Risk Center (cases, rogue launches, compliance, relayer health), analytics (`GET /api/v1/admin/analytics`: raised, fees collected, active audits, flagged projects, sponsored gas), staff list, settings, audit log.
- [ ] **API-82** Founder: `GET /api/v1/founder/projects/:id` (round state, milestones, pending creator funds, gas ledger overflow, compliance state), `PATCH` own description / pitch deck / website, revenue report (on-chain deposits vs observed inflow history).
- [ ] **API-83** Investor: portfolio, dividend / yield history, active votes with weights, relay request history (statuses of queued gasless actions) — wallet taken from the session account, not the URL.
- [ ] **API-84** Public: project list / detail with transparency panel (API-53); no authentication needed.

## Phase 8: Uploads

- [ ] **API-85** `[USER-ACTION]` Create two storage buckets (S3 or Supabase Storage): **public** for logos / pitch decks and **private** for KYC documents and Secret Shopper evidence; provide credentials in `.env`. Private bucket must block public access.
- [ ] **API-86** `multer` memory-limited multipart upload; validate by magic bytes + size + extension; re-encode images; random object keys; never trust client filenames; virus scan `[DEFERRED]`.
- [ ] **API-87** Storage utility: public CDN URLs for logos (`startup_profiles.logo_url`); signed, short-lived URLs for private objects.

## Phase 9: DevOps & Quality

- [ ] **API-90** Multi-stage `Dockerfile` (build TypeScript, run production bundle as non-root without devDependencies); separate entrypoint for the Secret Shopper worker.
- [ ] **API-91** Jest + supertest integration suite: health, accounts / sessions / CSRF / lockout, RBAC matrix, application state machine, KYC and agreement flows, reconciliation maths (tolerance, stablecoin), compliance transitions, relay intake validation and queue policy (mocked chain).
- [ ] **API-92** Unit tests for signature verification (wallet linking + relay payloads), gas-average and send-by calculations.
- [ ] **API-93** `npm audit` in CI; dependency update policy; pin Node 22 LTS.
- [ ] **API-94** `[USER-ACTION]` GitHub Actions CI (lint, typecheck, test, audit) per repo.
- [ ] **API-95** Refresh `api-instructions.md` to match this backlog (it still references Sepolia and old function names).
