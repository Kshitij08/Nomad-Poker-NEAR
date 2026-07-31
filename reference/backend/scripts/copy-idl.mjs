import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const sources = [
  path.join(backendRoot, "..", "shared", "idl", "poker_escrow.json"),
  path.join(backendRoot, "idl", "poker_escrow.json"),
];
const destDir = path.join(backendRoot, "idl");
const dest = path.join(destDir, "poker_escrow.json");

const source = sources.find((p) => fs.existsSync(p));
if (!source) {
  console.error("[copy-idl] poker_escrow.json not found in shared/idl or backend/idl");
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(source, dest);
console.log(`[copy-idl] ${source} -> ${dest}`);
