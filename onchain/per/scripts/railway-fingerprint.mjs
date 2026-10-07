// Read-only fingerprint of existing Railway projects, to prove M7 never changes them. For each
// service: variable names, a sha256 of the sorted variables (values are never printed or saved),
// the active deployment ids, and a sha256 of the service instance config.
//   node scripts/railway-fingerprint.mjs <out.json> <projectId>...
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";

const run = (args) => execFileSync("railway", args, { encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "pipe"] });
const sha = (s) => createHash("sha256").update(s).digest("hex");
const [out, ...projects] = process.argv.slice(2);
const result = { at: new Date().toISOString(), projects: [] };
for (const id of projects) {
  const p = JSON.parse(run(["status", "-p", id, "-e", "production", "--json"]));
  const entry = { id, name: p.name, environments: [] };
  for (const { node: env } of p.environments?.edges ?? []) {
    const e = { name: env.name, services: [] };
    for (const { node: inst } of env.serviceInstances?.edges ?? []) {
      const svcName = inst.serviceName ?? (p.services?.edges ?? []).map((x) => x.node).find((n) => n.id === inst.serviceId)?.name ?? inst.serviceId;
      let vars = {};
      try { vars = JSON.parse(run(["variable", "list", "-p", id, "-e", env.name, "-s", svcName, "--json"])); } catch (err) { vars = { error: String(err.stderr ?? err).slice(0, 120) }; }
      const sorted = Object.keys(vars).sort().map((k) => [k, vars[k]]);
      const { activeDeployments, latestDeployment, ...config } = inst;
      e.services.push({ name: svcName, variableNames: sorted.map(([k]) => k), variablesSha256: sha(JSON.stringify(sorted)),
        instanceConfigSha256: sha(JSON.stringify(config)), activeDeployments: (activeDeployments ?? []).map((d) => `${d.id} ${d.createdAt}`) });
    }
    entry.environments.push(e);
  }
  result.projects.push(entry);
}
fs.writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result.projects.map((p) => ({ name: p.name, services: p.environments.flatMap((e) => e.services.map((s) => `${e.name}/${s.name}: ${s.variableNames.length} vars, sha ${s.variablesSha256.slice(0, 12)}`)) }))));
