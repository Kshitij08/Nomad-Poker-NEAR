import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const destDir = path.join(backendRoot, "idl");
const dest = path.join(destDir, "poker_escrow.json");

// Railway uses root directory `backend` only — shared/idl is not in the build context.
// Keep a committed copy at backend/idl/poker_escrow.json for deploys.
const sources = [
  path.join(backendRoot, "idl", "poker_escrow.json"),
  path.join(backendRoot, "..", "shared", "idl", "poker_escrow.json"),
];

const source = sources.find((p) => fs.existsSync(p));
if (!source) {
  console.error(
    "[copy-idl] poker_escrow.json not found. Commit backend/idl/poker_escrow.json or run anchor build in the monorepo."
  );
  process.exit(1);
}

if (path.resolve(source) === path.resolve(dest)) {
  console.log(`[copy-idl] using committed ${dest}`);
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(source, dest);
console.log(`[copy-idl] ${source} -> ${dest}`);
