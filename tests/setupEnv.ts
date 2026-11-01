// Dummy values so modules that import the validated config can load in tests.
// The pg module is mocked, so this connection string is never used.
process.env["DATABASE_URL"] = "postgresql://test:test@localhost:5432/test";
process.env["NODE_ENV"] = "test";
