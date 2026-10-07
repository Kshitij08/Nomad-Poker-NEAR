// Route tests against a deployed backend: what each route returns, what it refuses, and that no
// route other than POST /verify accepts a write. Run the rate-limit test last (it uses up this
// client's minute).
//   BACKEND_URL=https://... ADMIN_TOKEN_FILE=<path> node --import tsx test/routes.test.ts
import fs from "fs";

const URL_ = process.env.BACKEND_URL ?? "https://poker-per-api-production.up.railway.app";
const ADMIN = fs.readFileSync(process.env.ADMIN_TOKEN_FILE ?? "", "utf8").trim();
const results: { name: string; pass: boolean; detail?: any }[] = [];
const check = (name: string, pass: boolean, detail?: any) => { results.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? "" : "  " + JSON.stringify(detail)}`); };
const req = async (method: string, p: string, opts: { auth?: string; body?: string; type?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
  if (opts.body !== undefined) headers["content-type"] = opts.type ?? "application/json";
  const r = await fetch(URL_ + p, { method, headers, body: opts.body });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body, headers: r.headers };
};

async function main() {
  const h = await req("GET", "/health");
  check("GET /health: 200, db ok, both RPCs reachable, keeper looping", h.status === 200 && h.body.ok && h.body.db === "ok" && h.body.l1Slot > 0 && h.body.rollupSlot > 0 && h.body.keeper.loops > 0, { status: h.status, keeper: h.body?.keeper?.loops });
  check("GET /health exposes no secrets (only public keys)", !JSON.stringify(h.body).match(/secret|token|DATABASE|postgres:/i), {});
  check("no X-Powered-By header", !h.headers.get("x-powered-by"), {});

  const lobby = await req("GET", "/tables");
  check("GET /tables: 200, an array of live tables", lobby.status === 200 && Array.isArray(lobby.body) && lobby.body.every((t: any) => t.live === true), { status: lobby.status });
  check("GET /tables/<bad address>: 400", (await req("GET", "/tables/not-an-address")).status === 400);
  check("GET /tables/<unknown>: 404", (await req("GET", "/tables/11111111111111111111111111111111")).status === 404);
  check("GET /tables/<unknown>/hands: 200, empty", (await req("GET", "/tables/11111111111111111111111111111111/hands")).body?.length === 0);
  check("GET /tables/<t>/hands/<bad hand>: 400", (await req("GET", "/tables/11111111111111111111111111111111/hands/-1")).status === 400);
  check("GET /tables/<t>/hands?before=<sql>: ignored safely (200)", (await req("GET", "/tables/11111111111111111111111111111111/hands?before=1;drop%20table%20hands")).status === 200);

  for (const [what, auth] of [["no token", undefined], ["a wrong token", "x".repeat(ADMIN.length)], ["a shorter token", "abc"]] as [string, string | undefined][]) {
    check(`GET /audit/events with ${what}: 401`, (await req("GET", "/audit/events", { auth })).status === 401);
    check(`GET /audit/.../log with ${what}: 401`, (await req("GET", "/audit/tables/11111111111111111111111111111111/hands/1/log", { auth })).status === 401);
  }
  const ev = await req("GET", "/audit/events?limit=5", { auth: ADMIN });
  check("GET /audit/events with the admin token: 200", ev.status === 200 && Array.isArray(ev.body), { status: ev.status });

  check("POST /verify, malformed body: 400", (await req("POST", "/verify", { body: JSON.stringify({ table: "x" }) })).status === 400);
  check("POST /verify, invalid JSON: 400", (await req("POST", "/verify", { body: "{not json" })).status === 400);
  check("POST /verify, unknown hand: 404", (await req("POST", "/verify", { body: JSON.stringify({ table: "11111111111111111111111111111111", handNo: "1", log: { entries: [] } }) })).status === 404);
  check("POST /verify, body over 64 KB: 413", (await req("POST", "/verify", { body: JSON.stringify({ pad: "x".repeat(70_000) }) })).status === 413);

  // No write routes besides /verify: every other method/path is refused.
  const writes: [string, string][] = [["POST", "/tables"], ["PUT", "/tables/11111111111111111111111111111111"], ["DELETE", "/tables/11111111111111111111111111111111"],
    ["POST", "/tables/11111111111111111111111111111111/hands"], ["POST", "/audit/events"], ["POST", "/tick"], ["POST", "/commit"], ["POST", "/sign"], ["POST", "/withdraw"]];
  for (const [m, p] of writes) check(`${m} ${p}: 404 (no such route)`, (await req(m, p, { body: "{}" })).status === 404);

  // Rate limit (120/min per IP by default): a burst gets 429 with Retry-After.
  const burst = await Promise.all(Array.from({ length: 140 }, () => req("GET", "/tables/11111111111111111111111111111111/hands")));
  const limited = burst.filter((r) => r.status === 429);
  check("a burst of 140 requests: the excess gets 429 with Retry-After", limited.length > 0 && limited.every((r) => r.headers.get("retry-after") === "60"), { limited: limited.length });

  const failed = results.filter((r) => !r.pass).length;
  const out = { suite: "m7-routes", backend: URL_, ranAt: new Date().toISOString(), pass: results.length - failed, fail: failed, outcomes: results };
  fs.writeFileSync(`../results/m7-routes-${Date.now()}.json`, JSON.stringify(out, null, 1));
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
