// Agents play each other (review 20 Oct, option 2): a table that already has Agents and room gets queued ones first,
// so they sit together instead of one per table; an empty table takes one only after a short wait.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { AgentDeploymentService, JOIN_WAIT_SECONDS } from "../src/services/agentDeployments.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Just enough of pg.Pool for the service: query, and connect() for transactions (PGlite is one connection). */
function poolOver(db: PGlite): Pool {
  const query = async (text: string, params?: unknown[]) => {
    const r = await db.query(text, params as any[]);
    return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
  };
  return { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
}

let pool: Pool, agents: AgentDeploymentService;

before(async () => {
  const db = new PGlite();
  for (const f of ["003_agent_deployments.sql", "007_agent_money.sql"])
    await db.exec(fs.readFileSync(path.join(here, "..", "migrations", f), "utf8"));
  pool = poolOver(db);
  agents = new AgentDeploymentService(pool);
});

const queue = (id: string, owner: string) => agents.enqueue({ deploymentId: id, ownerId: owner, agentName: owner, profile: "balanced",
  strategyVersion: "v2", strategyConfig: {}, bankroll: 5000, maxHands: 100, maxRuntimeSeconds: 600, stopLoss: 0, profitTarget: 0, stake: 1000 });
const playing = (id: string) => pool.query(`UPDATE agent_deployments SET phase = 'playing', updated_at = NOW() WHERE deployment_id = $1`, [id]);
const queuedSecondsAgo = (id: string, s: number) =>
  pool.query(`UPDATE agent_deployments SET created_at = NOW() - make_interval(secs => $2) WHERE deployment_id = $1`, [id, s]);

test("queued Agents go to the table that already has Agents; an empty table waits, then takes one", async () => {
  await queue("AGNTA0000001", "ann");
  const first = await agents.claim("t1", 1000, { agents: 0, cap: 4 }); // no table has Agents yet: no wait
  assert.equal(first?.deploymentId, "AGNTA0000001");
  await playing("AGNTA0000001");

  await queue("AGNTB0000001", "ben");
  assert.equal(await agents.claim("t2", 1000, { agents: 0, cap: 4 }), null); // t1 has an Agent and room
  const second = await agents.claim("t1", 1000, { agents: 1, cap: 4 });
  assert.equal(second?.deploymentId, "AGNTB0000001");
  assert.equal(second?.assignedTable ?? second?.AssignedTable, "t1");

  // A full table claims nothing; after the wait an empty one takes the next Agent.
  await queue("AGNTC0000001", "cat");
  assert.equal(await agents.claim("t1", 1000, { agents: 4, cap: 4 }), null);
  assert.equal(await agents.claim("t2", 1000, { agents: 0, cap: 4 }), null);
  await queuedSecondsAgo("AGNTC0000001", JOIN_WAIT_SECONDS + 1);
  assert.equal((await agents.claim("t2", 1000, { agents: 0, cap: 4 }))?.deploymentId, "AGNTC0000001");

  // Older game servers send no seating and claim as before.
  await queue("AGNTD0000001", "dan");
  assert.equal((await agents.claim("t3", 1000))?.deploymentId, "AGNTD0000001");
});
