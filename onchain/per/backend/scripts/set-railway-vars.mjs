// Sets the private-tables backend's Railway variables on the M7 test project, (profile "live") on the live
// private-tables project, or (profile "v3") on the new internal test program's service in poker-agents-v2-test. The project id is required and checked against the profile's project name. Secrets go
// over stdin, never on a command line, and are never printed. The archive key and admin token are generated
// once and kept next to the devnet keys (outside the repo) so tests can call the audit routes.
//   node scripts/set-railway-vars.mjs <projectId> <keysDir> [test|live]
// The live profile has its own keeper, archive key and admin token; the auditor key is the program config's one
// auditor, so it's shared. The v3 profile is separate test infrastructure for the new program (4A3DZW5z…): its own
// keeper, auditor, archive key, admin token and Postgres (a database of its own in that project, never coins-api's).
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

const [projectId, keysDir, profile = "test"] = process.argv.slice(2);
const PROFILES = {
  test: { name: "poker-per-m7-test", keeper: "keeper.json", archive: "m7-archive-key.hex", admin: "m7-admin-token.txt" },
  live: { name: "poker-per-live", keeper: "live-keeper.json", archive: "live-archive-key.hex", admin: "live-admin-token.txt" },
  v3: {
    name: "poker-agents-v2-test", service: "per-api-v3", keeper: "v3-keeper.json", auditor: "v3-auditor.json", archive: "v3-archive-key.hex", admin: "v3-admin-token.txt",
    database: "${{Postgres-per.DATABASE_URL}}",
    // Agents v2 policy: table hosting fees (requester pays, the measured net rent), and the SOL marketplace's listing minimum.
    extra: { HOST_FEE_LAMPORTS: "17000000", HOSTS_PER_WALLET_HOUR: "3", LISTING_MIN_HANDS: "100", LISTING_MIN_NET: "1" },
  },
};
const p = PROFILES[profile];
if (!p) throw new Error(`unknown profile ${profile}`);
const SERVICE = p.service ?? "poker-per-api", ENV = "production";
const rw = (args, input) => execFileSync("railway", args, { encoding: "utf8", input, shell: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
const status = JSON.parse(rw(["status", "-p", projectId, "-e", ENV, "--json"]));
if (status.name !== p.name) throw new Error(`refusing: project ${projectId} is "${status.name}", not ${p.name}`);

const secretFile = (name, make) => {
  const f = path.join(keysDir, name);
  if (!fs.existsSync(f)) fs.writeFileSync(f, make());
  return fs.readFileSync(f, "utf8").trim();
};
const vars = {
  KEEPER_SECRET_KEY: fs.readFileSync(path.join(keysDir, p.keeper), "utf8").trim(),
  AUDITOR_SECRET_KEY: fs.readFileSync(path.join(keysDir, p.auditor ?? "auditor.json"), "utf8").trim(),
  ARCHIVE_KEY_HEX: secretFile(p.archive, () => randomBytes(32).toString("hex")),
  ADMIN_TOKEN: secretFile(p.admin, () => randomBytes(32).toString("base64url")),
  DATABASE_URL: p.database ?? "${{Postgres.DATABASE_URL}}",
  SOLANA_RPC_URL: "https://api.devnet.solana.com",
  TEE_URL: "https://devnet-tee.magicblock.app",
  NODE_ENV: "production",
  ...(p.extra ?? {}),
};
for (const [k, v] of Object.entries(vars)) {
  rw(["variable", "set", k, "--stdin", "-s", SERVICE, "-e", ENV, "-p", projectId, "--skip-deploys", "--json"], v);
  console.log(`set ${k}`);
}
