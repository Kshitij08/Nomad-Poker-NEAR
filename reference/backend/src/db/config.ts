import type { ClientConfig } from "pg";

/**
 * Shared Postgres connection options for migrate, pool, and scripts.
 * Railway (and most hosted providers) require SSL when connecting from your machine.
 */
export function getPgConfig(): ClientConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required. Copy backend/.env.example to backend/.env."
    );
  }

  const sslMode = process.env.DATABASE_SSL?.toLowerCase();
  const useSsl =
    sslMode === "true" ||
    (sslMode !== "false" && !isLocalPostgres(databaseUrl));

  return {
    connectionString: databaseUrl,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  };
}

function isLocalPostgres(url: string): boolean {
  try {
    const parsed = new URL(url.replace(/^postgres:\/\//, "postgresql://"));
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export function formatConnectionTarget(url: string): string {
  try {
    const parsed = new URL(url.replace(/^postgres:\/\//, "postgresql://"));
    return `${parsed.hostname}:${parsed.port || "5432"}/${parsed.pathname.slice(1)}`;
  } catch {
    return "(invalid DATABASE_URL)";
  }
}
