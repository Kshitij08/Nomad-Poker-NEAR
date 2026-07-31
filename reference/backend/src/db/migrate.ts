import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import "dotenv/config";
import { formatConnectionTarget, getPgConfig } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required. Copy backend/.env.example to backend/.env."
    );
  }

  const client = new pg.Client(getPgConfig());

  try {
    await client.connect();
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ECONNREFUSED") {
      console.error(
        `Could not connect to Postgres at ${formatConnectionTarget(databaseUrl)} (ECONNREFUSED).\n\n` +
          "If using Railway: open your Postgres service → Connect → copy the **public** URL\n" +
          "into backend/.env as DATABASE_URL, then run migrate again.\n\n" +
          "See backend/README.md for Railway setup steps."
      );
      process.exit(1);
    }
    throw err;
  }

  const sqlPath = path.join(__dirname, "..", "..", "migrations", "001_initial.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  await client.query(sql);
  await client.end();
  console.log(`Migrations applied (${formatConnectionTarget(databaseUrl)}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
