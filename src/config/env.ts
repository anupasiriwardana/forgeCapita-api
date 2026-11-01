import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// URL"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = z.infer<typeof envSchema>;

function loadConfig(): Readonly<AppConfig> {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    // Report variable names and generic reasons only; never echo values.
    console.error("Invalid environment configuration:");
    for (const issue of result.error.issues) {
      const name = issue.path.join(".") || "(env)";
      const reason =
        process.env[name] === undefined
          ? "required"
          : issue.code === "invalid_format" || issue.code === "invalid_value"
            ? "invalid format"
            : issue.code === "too_small" || issue.code === "too_big"
              ? "out of range"
              : "invalid";
      console.error(`  - ${name}: ${reason}`);
    }
    process.exit(1);
  }
  return Object.freeze(result.data);
}

export const config: Readonly<AppConfig> = loadConfig();
