import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load IDL from backend/idl (deploy) or shared/idl (local monorepo).
 *
 * The IDL's baked-in `address` is overridden by POKER_PROGRAM_ID when set: Anchor 0.30 takes the
 * program it invokes from `idl.address`, while every PDA here is derived from `programId()`. If the
 * two disagree (a redeploy under a new id), transactions are sent to one program carrying accounts
 * owned by another and fail with AccountOwnedByWrongProgram. One source of truth avoids that.
 */
export function loadEscrowIdl(): Record<string, unknown> {
  const candidates = [
    path.join(__dirname, "../../idl/poker_escrow.json"),
    path.join(__dirname, "../../../shared/idl/poker_escrow.json"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const idl = JSON.parse(fs.readFileSync(candidate, "utf8")) as Record<string, unknown>;
      const configured = process.env.POKER_PROGRAM_ID?.trim();
      if (configured && idl.address !== configured) {
        console.warn(
          `[idl] Overriding IDL address ${String(idl.address)} with POKER_PROGRAM_ID ${configured}.`
        );
        idl.address = configured;
      }
      return idl;
    }
  }

  throw new Error(
    "poker_escrow.json not found. Run `npm run copy-idl` in backend/ or `npm run prebuild`."
  );
}
