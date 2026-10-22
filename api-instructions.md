# ForgeCapita Off-Chain API Specification

## 1. Project Context & Architecture
ForgeCapita is a Web3 milestone-gated crowdfunding and SaaS equity platform operating on the Ethereum Sepolia Testnet. 
The platform utilizes a dual-database architecture sharing a single Neon PostgreSQL instance:
1. **On-Chain Data (Ponder Indexer):** A running Ponder indexer automatically writes blockchain events (funds raised, milestones passed, governance votes) to the shared PostgreSQL database into specific tables (e.g., the `project` table).
2. **Off-Chain Data (This API):** The blockchain cannot cost-effectively store rich media and metadata. This backend API is responsible for saving off-chain startup metadata (logos, pitch decks, founder bios) into its own dedicated PostgreSQL table, and serving a unified dataset to the frontend by executing SQL `JOIN`s between the Express-managed off-chain tables and the Ponder-managed on-chain tables.

## 2. Technology Stack & Best Practices
* **Runtime:** Node.js with Express.js.
* **Language:** Strictly typed TypeScript.
* **Database Client:** `pg` (PostgreSQL Connection Pool).
* **Testing:** `jest` and `supertest` for integration testing.
* **Environment Configuration:** All sensitive data (database URLs, ports) must be managed via `dotenv`. The repository must include a `.env.example` file with placeholder values.
* **Security & Middleware:** Implement standard `cors` and `express.json()` middleware. Use a global error-handling middleware to catch and format API errors cleanly.

## 3. Directory Structure
Generate the project utilizing a clean, layered Controller-Service-Route architecture.

```text
forgecapita-api/
├── src/
│   ├── controllers/    # Express route handlers (req/res parsing)
│   ├── routes/         # Express router definitions
│   ├── services/       # Core business logic and SQL database execution
│   ├── db/             # PostgreSQL connection pool initialization (`pool.ts`)
│   ├── middlewares/    # Global error handlers and input validators
│   ├── types/          # TypeScript interfaces for request bodies and DB schemas
│   └── index.ts        # Express server entry point
├── tests/              # Jest integration tests (`api.test.ts`)
├── .env.example        # Environment variable placeholders
├── package.json        
├── tsconfig.json       
└── Dockerfile          # Configuration for Node 22 Alpine

```

## 4. Database Schema Requirements

This API must create and manage an off-chain table named `startup_profiles`.
*(Note: Do not create the `project` table, as Ponder manages it. Assume the `project` table exists with an `id` column matching the smart contract `MilestoneEscrow` hex address).*

**Table:** `startup_profiles`

* `project_id` (VARCHAR Primary Key) - Matches the `id` from the Ponder `project` table (e.g., `0xabc...`).
* `name` (VARCHAR Not Null) - The commercial name of the startup.
* `description` (TEXT Not Null) - A detailed description of the SaaS product.
* `logo_url` (VARCHAR) - URL to the project's logo.
* `pitch_deck_url` (VARCHAR) - URL to the PDF/slides.
* `founder_bio` (TEXT) - Background of the developer.
* `website_url` (VARCHAR) - Product landing page.
* `created_at` (TIMESTAMP default NOW()).

Provide a SQL initialization script or a function inside the `db/` directory that executes `CREATE TABLE IF NOT EXISTS` for `startup_profiles` when the server starts.

## 5. Required API Endpoints

### A. Health Check

* **GET `/health**`
* **Role:** Verifies server uptime and successful database pool connection.
* **Response:** `{ status: "API is running", database: "Connected" }`

### B. Create/Update Profile (Off-Chain Write)

* **POST `/api/projects/profile**`
* **Role:** Receives off-chain metadata from the frontend when a founder launches a project, and saves it to the `startup_profiles` table. Use an `INSERT ... ON CONFLICT DO UPDATE` (upsert) strategy based on the `project_id`.
* **Request Body:** `{ projectId, name, description, logoUrl, pitchDeckUrl, founderBio, websiteUrl }`
* **Response:** `{ success: true, message: "Profile saved", data: { ... } }`

### C. Get Unified Project Details (The SQL Join)

* **GET `/api/projects/:projectId**`
* **Role:** Fetches a single project by joining the off-chain `startup_profiles` table with the on-chain `project` table.
* **SQL Logic:**
`SELECT p.*, s.name, s.description, s.logo_url, s.pitch_deck_url, s.founder_bio, s.website_url FROM project p LEFT JOIN startup_profiles s ON p.id = s.project_id WHERE p.id = $1`
* **Response:** Returns the unified JSON object containing both the financial metrics and the rich metadata.

### D. Get All Unified Projects

* **GET `/api/projects**`
* **Role:** Returns an array of all active projects for the frontend marketplace dashboard, utilizing the same `LEFT JOIN` logic as above to append the off-chain `name` and `logo_url` to the on-chain financial metrics.

## 6. Testing Instructions

Include a fully functional test suite using `jest` and `supertest`.

* Write a test block that verifies the `/health` endpoint.
* Write a test block that mocks the PostgreSQL pool to simulate a successful `POST /api/projects/profile` insertion.
* Write a test block simulating the retrieval of merged GET endpoint data.
Instruct the testing framework to exit cleanly after execution.
