import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Load IDL from backend/idl (deploy) or shared/idl (local monorepo). */
export function loadEscrowIdl(): Record<string, unknown> {
  const candidates = [
    path.join(__dirname, "../../idl/poker_escrow.json"),
    path.join(__dirname, "../../../shared/idl/poker_escrow.json"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, "utf8"));
    }
  }

  throw new Error(
    "poker_escrow.json not found. Run `npm run copy-idl` in backend/ or `npm run prebuild`."
  );
}
