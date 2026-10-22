import express, { Request, Response } from "express";
import cors from "cors";
import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize PostgreSQL Connection Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// Test Database Connection
pool.connect((err, client, release) => {
    if (err) {
        console.error("❌ Error connecting to Neon PostgreSQL:", err.stack);
    } else {
        console.log("✅ Express successfully connected to shared Neon Database!");
        release();
    }
});

// Health Check Endpoint
app.get("/health", (req: Request, res: Response) => {
    res.status(200).json({ status: "API is running", database: "Connected" });
});

// Start Server
app.listen(port, () => {
    console.log(`🚀 forgeCapita API listening at http://localhost:${port}`);
});