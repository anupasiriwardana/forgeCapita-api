// Dummy values so modules that import the validated config can load in tests.
// The pg module is mocked, so this connection string is never used.
process.env["DATABASE_URL"] = "postgresql://test:test@localhost:5432/test";
process.env["NODE_ENV"] = "test";
process.env["CORS_ORIGINS"] = "http://localhost:3000,https://app.example.com";
process.env["LOG_LEVEL"] = "silent";
// High limits so unrelated tests never trip the limiters; rate-limit tests override these.
process.env["RATE_LIMIT_MAX"] = "100000";
process.env["PROFILE_RATE_LIMIT_MAX"] = "100000";
