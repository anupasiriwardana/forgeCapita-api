# forgeCapita-api
The off-chain Express.js REST API for forgeCapita serving startup metadata and merging it with Ponder's on-chain data via a shared PostgreSQL database.

## Migrations

API-owned tables live in the `app` schema and are managed by SQL files in `migrations/` (`NNN_name.sql`, contiguous from `001`, applied in order, each in its own transaction). The API never changes the schema on boot: it only checks that every migration file is applied and exits with `Database migrations are not applied. Run: npm run migrate` otherwise. Ponder data is read from the schema named by `PONDER_SCHEMA` (default `ponder`).

Applied files are recorded with a checksum in `app.schema_migrations`; editing an applied file makes `migrate` fail, so add a new numbered file instead. Migration files must not contain `BEGIN`/`COMMIT` or `CONCURRENTLY`.

Order of operations:

1. Commit the changes.
2. Optional: set `MIGRATION_DATABASE_URL` (the direct, non-pooled connection string) in your own `.env`; if unset, `DATABASE_URL` is used.
3. Run `docker compose exec -T api npm run migrate` (if the process already exited: `docker compose run --rm -T api npm run migrate`).
4. Confirm with `docker compose exec -T api npm run migrate:status`: `001` and `002` applied, 0 pending.
5. Restart the API and check `/health/db`.

Without Docker: `npm run migrate` and `npm run migrate:status`.
