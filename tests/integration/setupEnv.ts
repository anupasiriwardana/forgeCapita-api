// Runs before every integration test file and BEFORE any src import (src/config/env.ts parses
// process.env at import time). The API container loads a real env_file, so every value that
// matters is assigned explicitly here; the real DATABASE_URL is never read or used as a fallback.
import { DEFAULT_TEST_DATABASE_URL, assertSafeTestDatabaseUrl, withSslDisabled } from "./guard.js";

const testUrl = process.env["INTEGRATION_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL;
const host = assertSafeTestDatabaseUrl(testUrl);
console.log(`[integration] database host: ${host}`);

process.env["DATABASE_URL"] = withSslDisabled(testUrl);
delete process.env["MIGRATION_DATABASE_URL"];
process.env["PONDER_SCHEMA"] = "ponder";
process.env["NODE_ENV"] = "test";
process.env["LOG_LEVEL"] = "silent";
process.env["CORS_ORIGINS"] = "http://localhost:3000";
process.env["ADMIN_WALLETS"] = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
process.env["RELAYER_ENABLED"] = "false";
process.env["MILESTONE_AUTOMATIC_EXECUTION"] = "false";
delete process.env["RELAYER_PRIVATE_KEY"];
delete process.env["RPC_URL_421614"];
delete process.env["RPC_URL_97"];
// The real env_file may enable the revenue audit; tests must never reach a real explorer.
// Empty (not delete): dotenv re-reads the env file at import and would restore deleted variables,
// but never overrides defined ones, and the schema treats empty as unset.
process.env["ETHERSCAN_API_KEY"] = "";
process.env["REVENUE_AUDIT_CHAINS"] = "";
process.env["REVENUE_TOLERANCE_BPS"] = "";
process.env["REVENUE_AUDIT_ENABLED"] = "false";
// The real env file may set the minimum-goal mode; tests pin it (assigned, because dotenv restores deleted vars).
process.env["MINIMUM_GOAL_MODE"] = "test";
