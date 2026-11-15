// Dummy values so modules that import the validated config can load in tests.
// The pg module is mocked, so this connection string is never used.
process.env["DATABASE_URL"] = "postgresql://test:test@localhost:5432/test";
process.env["NODE_ENV"] = "test";
process.env["CORS_ORIGINS"] = "http://localhost:3000,https://app.example.com";
process.env["LOG_LEVEL"] = "silent";
// Pinned so the real env file cannot change draft-creation tests; the live-mode tests override it.
process.env["MINIMUM_GOAL_MODE"] = "test";
// Assigned empty (not deleted) so the real env file can never enable GitHub provisioning in tests.
for (const name of ["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY_BASE64", "GITHUB_ORG", "REPO_BRANCH_PROTECTION"]) {
  process.env[name] = "";
}
// High limits so unrelated tests never trip the limiters; rate-limit tests override these.
process.env["RATE_LIMIT_MAX"] = "100000";
process.env["PROFILE_RATE_LIMIT_MAX"] = "100000";
process.env["AUTH_RATE_LIMIT_MAX"] = "100000";
// Address of the well-known test key 0x00..01 (tests/auth.test.ts signs with it).
process.env["ADMIN_WALLETS"] = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
