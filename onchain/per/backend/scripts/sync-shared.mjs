// Copies the program IDL and the off-chain verifier into src/shared, so the service deploys as one
// self-contained folder. `--check` fails if the copies differ from their sources (run before deploy).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pairs = [["../../idl/poker_per.json", "../src/shared/poker_per.json"], ["../../tests/verifier.ts", "../src/shared/verifier.ts"]];
let stale = 0;
for (const [from, to] of pairs) {
  const src = fs.readFileSync(path.join(here, from));
  const dst = path.join(here, to);
  const same = fs.existsSync(dst) && fs.readFileSync(dst).equals(src);
  if (process.argv.includes("--check")) { if (!same) { console.error(`stale: ${to}`); stale++; } continue; }
  if (!same) fs.writeFileSync(dst, src);
  console.log(`${same ? "unchanged" : "copied"}: ${to}`);
}
process.exit(stale ? 1 : 0);
