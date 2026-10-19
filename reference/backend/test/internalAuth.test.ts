import assert from "node:assert/strict";
import { test } from "node:test";
import { requireInternalApiKey } from "../src/middleware/internalAuth.js";

function run(headers: Record<string, string>) {
  let status = 0, passed = false;
  const req: any = { header: (h: string) => headers[h.toLowerCase()] };
  const res: any = { status(s: number) { status = s; return this; }, json() { return this; } };
  requireInternalApiKey(req, res, () => { passed = true; });
  return { status, passed };
}

test("internal routes: refused without a configured key, unless explicitly optional (local development)", () => {
  const saved = { key: process.env.INTERNAL_API_KEY, optional: process.env.INTERNAL_API_KEY_OPTIONAL };
  try {
    delete process.env.INTERNAL_API_KEY; delete process.env.INTERNAL_API_KEY_OPTIONAL;
    assert.deepEqual(run({}), { status: 503, passed: false });
    process.env.INTERNAL_API_KEY_OPTIONAL = "1";
    assert.deepEqual(run({}), { status: 0, passed: true });
    delete process.env.INTERNAL_API_KEY_OPTIONAL;
    process.env.INTERNAL_API_KEY = "k".repeat(32);
    assert.deepEqual(run({}), { status: 401, passed: false });
    assert.deepEqual(run({ "x-api-key": "wrong" }), { status: 401, passed: false });
    assert.deepEqual(run({ "x-api-key": "k".repeat(32) }), { status: 0, passed: true });
    assert.deepEqual(run({ authorization: "Bearer " + "k".repeat(32) }), { status: 0, passed: true });
  } finally {
    if (saved.key === undefined) delete process.env.INTERNAL_API_KEY; else process.env.INTERNAL_API_KEY = saved.key;
    if (saved.optional === undefined) delete process.env.INTERNAL_API_KEY_OPTIONAL; else process.env.INTERNAL_API_KEY_OPTIONAL = saved.optional;
  }
});
