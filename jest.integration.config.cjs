/**
 * Jest config for the real-Postgres integration tests (`npm run test:integration`).
 * Separate from the unit config in package.json: unit tests mock pg, these need a database.
 * Files are named *.itest.ts so the unit run never picks them up.
 */
module.exports = {
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/tests/integration/**/*.itest.ts"],
  setupFiles: ["<rootDir>/tests/integration/setupEnv.ts"],
  maxWorkers: 1,
  testTimeout: 45000,
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: { "^(\.{1,2}/.+)\.js$": "$1" },
  transform: {
    "^.+\.tsx?$": [
      "@swc/jest",
      {
        jsc: { parser: { syntax: "typescript", decorators: false }, target: "es2022" },
        module: { type: "es6" },
      },
    ],
  },
};
