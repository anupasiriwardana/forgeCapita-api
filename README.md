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

`POST /api/projects/profile` upserts a profile for a composite `projectId` (optional `category`). It is currently unauthenticated (TODO API-20, WS-06) and rate limited.

## Probes, versioning and OpenAPI

- `GET /health` is liveness; `GET /ready` returns `200` when the DB is reachable and every migration is applied, else `503 {"success":false,"error":"Not ready"}`. Both are exempt from rate limiting and request logs. Indexer reachability is deferred (the API has no indexer URL; both share the same Neon DB).
- Canonical routes are `/api/v1/projects`. `/api/projects` is a deprecated alias (same handlers, no redirect) to be removed once the frontend moves to `/api/v1`. The Postman collection is stale and still uses `/api/projects`.
- `GET /api/v1/openapi.json` serves a hand-written OpenAPI 3.0.3 document (`src/openapi.ts`) outside production only; in production it is a normal 404. Deferred: a generated/zod-derived document, an `/api/docs` HTML UI and a drift check.
- The container has `sh` only: use `docker compose exec api sh`. `ponder_rpc_cache_1` in Neon is Ponder's RPC cache, not the API's.
