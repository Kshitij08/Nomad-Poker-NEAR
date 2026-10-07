// Sets the new backend's Railway variables on the M7 test project only (its id is required and
// checked against the project's name). Secrets go over stdin, never on a command line, and are
// never printed. The archive key and admin token are generated once and kept next to the devnet
// keys (outside the repo) so tests can call the audit routes.
//   node scripts/set-railway-vars.mjs <projectId> <keysDir>
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

const [projectId, keysDir] = process.argv.slice(2);
const SERVICE = "poker-per-api", ENV = "production", EXPECTED_NAME = "poker-per-m7-test";
const rw = (args, input) => execFileSync("railway", args, { encoding: "utf8", input, shell: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
const status = JSON.parse(rw(["status", "-p", projectId, "-e", ENV, "--json"]));
if (status.name !== EXPECTED_NAME) throw new Error(`refusing: project ${projectId} is "${status.name}", not ${EXPECTED_NAME}`);

const secretFile = (name, make) => {
  const f = path.join(keysDir, name);
  if (!fs.existsSync(f)) fs.writeFileSync(f, make());
  return fs.readFileSync(f, "utf8").trim();
};
const vars = {
  KEEPER_SECRET_KEY: fs.readFileSync(path.join(keysDir, "keeper.json"), "utf8").trim(),
  AUDITOR_SECRET_KEY: fs.readFileSync(path.join(keysDir, "auditor.json"), "utf8").trim(),
  ARCHIVE_KEY_HEX: secretFile("m7-archive-key.hex", () => randomBytes(32).toString("hex")),
  ADMIN_TOKEN: secretFile("m7-admin-token.txt", () => randomBytes(32).toString("base64url")),
  DATABASE_URL: "${{Postgres.DATABASE_URL}}",
  SOLANA_RPC_URL: "https://api.devnet.solana.com",
  TEE_URL: "https://devnet-tee.magicblock.app",
  NODE_ENV: "production",
};
for (const [k, v] of Object.entries(vars)) {
  rw(["variable", "set", k, "--stdin", "-s", SERVICE, "-e", ENV, "-p", projectId, "--skip-deploys", "--json"], v);
  console.log(`set ${k}`);
}
