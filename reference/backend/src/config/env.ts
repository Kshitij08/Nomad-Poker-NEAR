import dotenv from "dotenv";
import path from "node:path";

// Load backend/poker.env first (the project's canonical env file), then fall back
// to a standard .env for anything it doesn't define. dotenv never overrides
// variables already present in the real environment, so Railway config wins.
dotenv.config({ path: path.resolve(process.cwd(), "poker.env") });
dotenv.config();
