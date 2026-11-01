import { config } from "./config/env.js";
import express from "express";
import cors from "cors";

import { initDb } from "./db/pool.js";
import healthRoutes from "./routes/healthRoutes.js";
import projectRoutes from "./routes/projectRoutes.js";
import { errorHandler, notFoundHandler } from "./middlewares/errorHandler.js";

const app = express();
const port = config.PORT;

// ─── Core Middleware ──────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/health", healthRoutes);
app.use("/api/projects", projectRoutes);

// ─── Fallback Middleware ──────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot(): Promise<void> {
  try {
    // Ensure startup_profiles table exists before accepting traffic
    await initDb();

    app.listen(port, () => {
      console.log(`🚀 forgeCapita API listening at http://localhost:${port}`);
    });
  } catch (err) {
    console.error("❌ Failed to initialise database:", err);
    process.exit(1);
  }
}

boot();

// Export app for supertest (tests import this without calling listen)
export default app;