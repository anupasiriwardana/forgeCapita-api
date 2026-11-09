# forgeCapita-api
The off-chain Express.js REST API for forgeCapita serving startup metadata and merging it with Ponder's on-chain data via a shared PostgreSQL database.

## Migrations

API-owned tables live in the `app` schema and are managed by SQL files in `migrations/` (`NNN_name.sql`, `001`-`003` today, contiguous from `001`, applied in order, each in its own transaction). The API never changes the schema on boot: it only checks that every migration file is applied and exits with `Database migrations are not applied. Run: npm run migrate` otherwise. Ponder data is read from the schema named by `PONDER_SCHEMA` (default `ponder`).

Applied files are recorded with a checksum in `app.schema_migrations`; editing an applied file makes `migrate` fail, so add a new numbered file instead. Migration files must not contain `BEGIN`/`COMMIT` or `CONCURRENTLY`.

Order of operations:

1. Commit the changes.
2. Optional: set `MIGRATION_DATABASE_URL` (the direct, non-pooled connection string) in your own `.env`; if unset, `DATABASE_URL` is used.
3. Run `docker compose exec -T api npm run migrate` (if the process already exited: `docker compose run --rm -T api npm run migrate`).
4. Confirm with `docker compose exec -T api npm run migrate:status`: `001` to `003` applied, 0 pending.
5. Restart the API and check `/health/db`.

Without Docker: `npm run migrate` and `npm run migrate:status`.

## Projects API

`GET /api/projects` lists indexed projects joined with their optional off-chain profile. Query parameters are validated strictly: unknown keys, repeated keys and out-of-range values return `400`.

| Param | Values | Default / cap |
|---|---|---|
| `limit` | integer | `20`, 1-100 |
| `offset` | integer | `0`, max 10000 |
| `chainId` | `421614` or `97` | none |
| `state` | `FUNDING`, `ACTIVE`, `COMPLETED`, `FAILED`, `CANCELLED`, `SHUTDOWN` | none |
| `developer` | `0x` address (lowercased) | none |
| `q` | 1-64 chars, case-insensitive match on token name or symbol (wildcards are literal) | none |
| `category` | slug `^[a-z0-9][a-z0-9-]{0,31}$` | none |
| `hasProfile` | exactly `true` or `false` | none |
| `sort` | `created_at`, `total_raised`, `funding_goal` | `created_at` |
| `order` | `asc`, `desc` | `desc` (ties broken by project id) |

Response: `{ "success": true, "data": { "items": [...], "total": N, "limit": N, "offset": N } }`, where `total` counts all rows matching the filters. `GET /api/projects/:projectId` takes the composite id `<chainId>:<escrow address>` (for example `421614:0x...`) and returns `{ "success": true, "data": <item> }`, or `404` if unknown.

Every on-chain `bigint` value (`fundingGoal`, `totalRaised`, `fundingDeadline`, `totalStaked`, `createdAt`, ...) is a decimal string, or `null` when unset; never parse it as a JS number. `chainId` and the milestone indexes are plain numbers. Each item has `profile: null` when no profile exists, otherwise only the public fields `name`, `description`, `logoUrl`, `pitchDeckUrl`, `founderBio`, `websiteUrl`, `category`, `updatedAt`. `shadow_wallet` and `kyc_verified` are never returned.

`POST /api/projects/profile` upserts a profile for a composite `projectId` (optional `category`). It requires a signed-in session (see Authentication), is rate limited, and only the indexed project's developer (or a `staff`/`admin` user) may write it.

## Authentication

Wallet sign-in (EIP-4361-style, no chain id) creates an opaque server-side session in an httpOnly `fc_session` cookie. There is no session secret: tokens are 32 random bytes and only their sha256 is stored in `app.sessions`. Run `npm run migrate` to create `app.users`, `app.auth_nonces` and `app.sessions` (migration 004).

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/auth/nonce` `{address}` | Returns `{nonce, message, expiresAt}` (valid 5 min); sign `message` with `personal_sign` |
| `POST /api/v1/auth/verify` `{address, signature}` | Single-use nonce; sets the cookie, returns `{user:{id,address,role}}`; any failure is a generic `401 Sign-in failed` |
| `GET /api/v1/auth/me` | Current user or `401` |
| `POST /api/v1/auth/logout` | Deletes the session, clears the cookie, `204` |

Responses use the usual `{success, data}` envelope. Sessions last 30 days (absolute), expire after 7 idle days, and each user keeps at most 5. Roles are `investor` (default), `founder`, `staff`, `admin`; wallets in `ADMIN_WALLETS` become `admin` on every login. Browser clients must send `credentials: "include"`; any non-GET request carrying the cookie must come from an origin in `CORS_ORIGINS`, else `403`.

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_WALLETS` | none | Comma-separated admin wallets |
| `AUTH_DOMAIN` | host of first `CORS_ORIGINS` | Domain in the sign-in message |
| `SESSION_COOKIE_SAMESITE` | `lax` | `lax` or `none` (`none` forces `Secure`) |
| `AUTH_RATE_LIMIT_MAX` | `10` | Per-window limit shared by `/auth/nonce` and `/auth/verify` |

## Admin API

Run `npm run migrate` for migration 005 (`app.audit_log`, append-only: triggers reject UPDATE, DELETE and TRUNCATE). All responses are `Cache-Control: no-store`.

| Endpoint | Access | Purpose |
|---|---|---|
| `PATCH /api/v1/admin/users/:address/role` `{role}` | `admin` | Set a role to `founder`, `staff` or `investor`; returns `{user:{id,address,role}}` |
| `GET /api/v1/admin/audit-log?limit&offset&action&target&actor` | `admin`, `staff` | Paged audit log (read-only) |
| `GET /api/v1/admin/launch-drafts?limit&offset&status&userId&chainId` | `admin`, `staff` | Paged launch drafts with the owner wallet (name only, never the payload) |
| `GET /api/v1/admin/relay-requests?limit&offset&kind&status&chainId&system&projectId` | `admin`, `staff` | Paged relay requests (never args or payload) |
| `GET /api/v1/relay/status` | public | Per-chain relayer health; `balance` is `ok`, `low`, `empty` or `unknown`; cached 30 s |
| `GET /api/v1/admin/users?limit&offset&role&q` | `admin`, `staff` | Paged user list (`q` is a lowercase hex address prefix); `{items,total,limit,offset}` |

`admin` is never assignable through the API (grant it via `ADMIN_WALLETS`). Admins, `ADMIN_WALLETS` wallets, unknown users and self-changes are rejected (`403`/`404`). A role change updates the user, writes one audit row (actor, target, before/after, IP) and deletes the target's sessions in a single SQL statement, so the new role applies on their next sign-in. Each successful login also deletes expired and idle sessions.

## Founder applications

Run `npm run migrate` for migration 006 (`app.founder_applications`; one open `pending`/`approved` application per wallet, a rejected founder may reapply). Responses are `Cache-Control: no-store`.

| Endpoint | Access | Purpose |
|---|---|---|
| `POST /api/v1/applications` `{projectName,summary,websiteUrl,pitchDeckUrl,repoUrl?,contact?}` | `investor`, `founder` | Submit (`201`; `409` if an open application exists). URLs must be https; `repoUrl` must be github.com or gitlab.com |
| `GET /api/v1/applications/mine` | signed in | Caller's latest application or `null` |
| `GET /api/v1/admin/applications?status&limit&offset` | `admin`, `staff` | Paged list; `{items,total,limit,offset}` |
| `GET /api/v1/admin/applications/:id` | `admin`, `staff` | One application (includes reviewer ids) |
| `POST /api/v1/admin/applications/:id/approve` `{kycVerified:true,note?}` | `admin`, `staff` | Pending only; stamps KYC, grants `founder` to a current `investor` (never downgrades staff/admin) and revokes their sessions |
| `POST /api/v1/admin/applications/:id/reject` `{note}` | `admin`, `staff` | Pending only; note required |

Approve/reject each run as one SQL statement (transition, role grant, session revocation and `application.approve` / `application.reject` / `role.change` audit rows). `404` unknown id, `409` not pending, `403` reviewing one's own application. `contact` is visible only to the applicant and staff/admin.

## Founder agreement and shadow wallet

Run `npm run migrate` for migration 007. The agreement text lives in `legal/` (placeholder draft, loaded once; the folder must ship with the API). Replay protection: the server builds the signed message (wallet included), `issuedAt` must be within 10 minutes of now, and `(user_id, agreement_version)` is unique.

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /api/v1/agreement` | public | `{version,textHash,text,messageTemplate}` (placeholders `{name}`, `{wallet}`, `{issuedAt}`) |
| `POST /api/v1/founders/me/agreement` `{typedName,issuedAt,signature}` | `founder` | Verify the wallet signature, store acceptance (`201`; `400` bad signature/stale time; `409` already accepted) |
| `POST /api/v1/founders/me/shadow-wallet` `{address}` | `founder` | Declare a shadow wallet (`409` if one is open) |
| `GET /api/v1/founders/me` | `founder` | Agreement and latest shadow wallet |
| `GET /api/v1/founders/me/launch-eligibility` | signed in | `{eligible,checks}` (application approved, agreement accepted, shadow wallet approved) |
| `GET /api/v1/admin/shadow-wallets?status&limit&offset`, `POST .../:id/approve` `{note?}`, `POST .../:id/reject` `{note}` | `admin`, `staff` | Review; pending only, not one's own (`403`), single audited statement |

## Launch drafts

Run `npm run migrate` for migration 009. The profile and the shadow wallet reservation are saved BEFORE the on-chain launch; after launching, the client attaches the escrow address and a background job applies the draft to `startup_profiles` once the indexer has the project and its developer matches the draft's wallet.

| Endpoint | Access | Purpose |
|---|---|---|
| `POST /api/v1/launch-drafts` `{chainId,name,description,founderBio?,logoUrl?,websiteUrl?,pitchDeckUrl?,category?,shadowWalletId?}` | `founder`, `staff`, `admin` | Create a pending draft (`201`). Founders must be eligible (`403`) and send an own approved, free wallet (`400` unavailable, `409` reserved or bound) |
| `POST /api/v1/launch-drafts/:id/attach` `{escrowAddress}` | owner | Pending to attached (idempotent for the same address; `409` other address or project taken); applies immediately when already indexed |
| `POST /api/v1/launch-drafts/:id/cancel` | owner | Pending only (`409` once attached); releases the wallet |
| `GET /api/v1/launch-drafts/mine` | signed in | Own drafts, newest first (20) |

Reconcile job: every `DRAFT_RECONCILE_INTERVAL_MS` (default `15000`, minimum `5000`; not started when `NODE_ENV=test`) under a Postgres advisory lock. Matched drafts become `applied` (`conflict` when a profile already exists for the project); pending drafts older than 7 days become `expired`. `GET /founders/me` wallets carry `reserved`.

## Gasless relayer

Run `npm run migrate` for migration 010. The API can send claim, stake and vote transactions from a relayer wallet that is allow-listed in the registry. Refund, unstake, yield claims and investing are always user-paid. Disabled unless `RELAYER_ENABLED=true` and `RELAYER_PRIVATE_KEY` plus `RPC_URL_<chainId>` are set (see `.env.example`); otherwise every relay route answers `503 {code:"RELAY_DISABLED"}` and the server boots normally. A chain is also disabled when the relayer is not allow-listed there.

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/relay/claim` `{projectId}` | Claim the session wallet tokens |
| `POST /api/v1/relay/vote` `{projectId,support,deadline,signature}` | EIP-712 vote over the CURRENT on-chain milestone index (read by the server) |
| `POST /api/v1/relay/stake` `{projectId,amount,deadline,signature}` | ERC-2612 permit stake; `amount` is a wei decimal string |
| `GET /api/v1/relay/:id`, `GET /api/v1/relay?limit` | Own requests only |

All routes need a session; writes need a same-origin request. Intake simulates the call as the relayer: a revert is never queued and maps to a stable `code` (`SELF_PAY`, `ALREADY_VOTED`, `NO_VOTING_POWER`, `VOTING_ENDED`, `ALREADY_CLAIMED`, `FUNDING_ACTIVE`, `SIMULATION_FAILED`). Other codes: `GAS_TOO_HIGH`, `USER_DAILY_LIMIT`, `CHAIN_DAILY_LIMIT`, `RELAYER_LOW_BALANCE`, `SIGNATURE_MISMATCH`. `202 {id,status}` on accept, `200` on an idempotent repeat. A worker (every 3 s, not under `NODE_ENV=test`) moves requests QUEUED, SENDING, SENT, CONFIRMED (or FAILED/EXPIRED); rows left SENDING without a hash at boot are failed as `INTERRUPTED`.

## Automatic milestone execution

Run `npm run migrate` for migration 011 (adds the `execute` kind and lets that kind have a NULL `user_id`; user kinds still require a user). Off unless `MILESTONE_AUTOMATIC_EXECUTION=true` (any other value or unset = off) AND the relayer has at least one enabled chain; never started under `NODE_ENV=test`. Startup logs `milestone auto-execution enabled` or `disabled`.

Every `MILESTONE_AUTOEXEC_INTERVAL_MS` (default `60000`, 15000 to 3600000) under advisory lock `727361003` the job reads indexed candidates (project `ACTIVE`, current milestone open and unexecuted, indexed voting end at least 15 s in the past, 50 per tick), then re-checks the chain (not cancelled/completed, same milestone index, open, unexecuted, `now >= votingEndTime + 15 s`), simulates `executeMilestone()` as the relayer and queues a system `execute` row (`idem_key execute:<chain>:<escrow>:<index>`, `user_id` NULL, `account` = relayer) that the normal relay worker sends and confirms. It never acts before the voting end: when yes votes exceed half the public supply the developer executes manually. If the vote ended without approval the contract cancels the project and opens refunds (as for any caller).

Simulation outcomes: `Milestones frozen` is retried next tick without a row; `Gas ceiling exceeded` stores one FAILED `SELF_PAY` row and is never retried; other reverts store a FAILED `SIMULATION_FAILED` row and are retried at most `MILESTONE_AUTOEXEC_MAX_ATTEMPTS` times (default 3), at least 1 hour apart (failed or expired execute rows count as attempts). Execute rows are not listed in the user relay endpoints.

## Revenue audit (inflows)

Run `npm run migrate` for migration 012 (`app.inflow_records`, `app.inflow_cursors`). Off unless `REVENUE_AUDIT_ENABLED=true` (exact value) AND `ETHERSCAN_API_KEY` is set; never started under `NODE_ENV=test`. Startup logs `revenue audit enabled` and `revenue audit chains: <ids>`, or `revenue audit disabled`. The key is never logged or returned.

Every `EXPLORER_POLL_INTERVAL_MS` (default `900000`, 60000 to 3600000) under advisory lock `727361004` the job takes up to 50 approved, bound shadow wallets (`startup_profiles.founder_wallet_id` joined to an `approved` `founder_wallets` row) on the chains in `REVENUE_AUDIT_CHAINS` (`421614`, `97`; default `421614`) and reads, through the Etherscan V2 API (`EXPLORER_BASE_URL`, https only; calls spaced by `EXPLORER_MIN_INTERVAL_MS`, default 600), incoming normal native transfers (`txlist`), contract-sent native transfers (`txlistinternal`) and ERC-20 transfers (`tokentx`). Each kind keeps a cursor with a 20-block reorg margin; rows are stored once (`UNIQUE (chain_id, tx_hash, kind, entry_ref)`), amounts as exact integers. A failing wallet records a short `last_error` and the pass continues. This step only ingests: nothing is compared or flagged yet.

`GET /api/v1/admin/inflows` (staff or admin; query `chainId`, `projectId`, `kind`, `limit` max 100, `offset` max 10000) returns `{items,total,limit,offset}`, plus `cursors` when `projectId` is given.

## Probes, versioning and OpenAPI

- `GET /health` is liveness; `GET /ready` returns `200` when the DB is reachable and every migration is applied, else `503 {"success":false,"error":"Not ready"}`. Both are exempt from rate limiting and request logs. Indexer reachability is deferred (the API has no indexer URL; both share the same Neon DB).
- Canonical routes are `/api/v1/projects`. `/api/projects` is a deprecated alias (same handlers, no redirect) to be removed once the frontend moves to `/api/v1`. The Postman collection is stale and still uses `/api/projects`.
- `GET /api/v1/openapi.json` serves a hand-written OpenAPI 3.0.3 document (`src/openapi.ts`) outside production only; in production it is a normal 404. Deferred: a generated/zod-derived document, an `/api/docs` HTML UI and a drift check.
- The container has `sh` only: use `docker compose exec api sh`. `ponder_rpc_cache_1` in Neon is Ponder's RPC cache, not the API's.

## Integration tests (real Postgres)

The unit tests (`npm test`) mock `pg`, so they never prove that the SQL runs. `npm run test:integration` runs the real repository and service functions against a throwaway Postgres 16 (files `tests/integration/*.itest.ts`, config `jest.integration.config.cjs`, serial). `npm test` does not run them.

Locally (from the repo root, with the compose project running):

```sh
docker compose --profile test up -d --wait pg_test
docker compose exec -T api npm run test:integration
docker compose --profile test stop pg_test && docker compose --profile test rm -f pg_test
```

`pg_test` (postgres:16-alpine, test credentials, tmpfs data, compose profile `test`) is never started by default and keeps no data. The `api` container reaches it as `pg_test:5432`; from the host use `INTEGRATION_DATABASE_URL=postgresql://test:test@localhost:5433/forgecapita_test npm run test:integration`. CI runs the same suite against a `postgres:16` service (`.github/workflows/ci.yml`).

Safety guard (`tests/integration/guard.ts`, run in the setup file before any `src` import and again before every DROP): the suite aborts unless the URL host is exactly `pg_test`, `localhost` or `127.0.0.1` AND the database is `forgecapita_test`. The URL comes only from `INTEGRATION_DATABASE_URL` or the built-in default; the real `DATABASE_URL` of the container (`env_file`) is overwritten and never used as a fallback. Only the host name is logged. `guard.itest.ts` proves a Neon-style URL is refused.

Per test file the harness drops and recreates the `app` and `ponder` schemas, applies every migration (twice, the second run must be a no-op), and creates stub `ponder.project` and `ponder.milestone` tables with the generated Ponder column names and types. Between tests every table is truncated; `app.audit_log` rejects TRUNCATE by design, so the reset disables its user triggers inside one transaction (the append-only triggers are tested separately with them enabled). The local test database has no TLS, so the URL carries `sslmode=disable` (it overrides the always-on `ssl` option of `src/db/pool.ts`).

Covered: migrations 001 to 011 (apply, no-op rerun, raw re-execution, tables, triggers, partial indexes); auth (nonces, users, sessions, pruning, expiry, user list); admin role change CTE; audit append-only triggers; founder applications (submit, approve/reject CTEs, self review, role promotion, session revocation); shadow wallets and agreement acceptance; profile upsert CTE with wallet binding and the project read joins against the Ponder stubs; launch drafts (create, attach, cancel, expiry, reconcile apply/conflict, `SKIP LOCKED`, concurrent reconcile); relay queue (idempotent insert, retry rename, quotas, claim ordering, concurrent claim, state transitions, recovery, execute candidates and history).

Not covered: the HTTP layer and middleware (unit tests), the on-chain relayer sender and milestone auto-execution job logic (mocked chains), the real Ponder-generated schema (only the columns the API reads are stubbed; keep them in sync with `forgecapita-indexer/ponder.schema.ts`), Neon-specific behaviour (pooler, TLS) and the `/ready` probe.
