/**
 * The D1 bridge: runs one SQL statement for the PER container (container/src/db.ts) on the PER database. The container
 * reaches it as an outbound handler (`http://d1.per/query`), so it never holds a database credential, and nothing
 * outside the container can call it. Blobs travel as `{ $b: base64 }` both ways.
 */

export interface BridgeRequest {
  sql: string;
  params?: unknown[];
}

export interface BridgeResponse {
  rows?: Record<string, unknown>[];
  changes?: number;
  error?: string;
}

const MAX_SQL = 20_000;
const MAX_PARAMS = 100;

function decodeParam(v: unknown): unknown {
  if (v !== null && typeof v === 'object' && typeof (v as { $b?: unknown }).$b === 'string') {
    const bin = atob((v as { $b: string }).$b);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  return v;
}

function encodeValue(v: unknown): unknown {
  if (v instanceof ArrayBuffer) v = new Uint8Array(v);
  if (ArrayBuffer.isView(v)) {
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return { $b: btoa(s) };
  }
  // D1 returns BLOB columns as arrays of byte values.
  if (Array.isArray(v) && v.every((x) => typeof x === 'number' && x >= 0 && x <= 255)) return encodeValue(Uint8Array.from(v));
  return v;
}

export async function runQuery(db: D1Database, req: BridgeRequest): Promise<BridgeResponse> {
  if (typeof req?.sql !== 'string' || req.sql.length > MAX_SQL) return { error: 'bad sql' };
  const params = Array.isArray(req.params) ? req.params : [];
  if (params.length > MAX_PARAMS) return { error: 'too many params' };
  try {
    const r = await db.prepare(req.sql).bind(...params.map(decodeParam)).all<Record<string, unknown>>();
    const rows = (r.results ?? []).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, encodeValue(v)])));
    return { rows, changes: r.meta?.changes ?? 0 };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 500) };
  }
}

/** The bridge as an HTTP handler (the outbound handler in the Worker; a local server in tests and local runs). */
export async function bridgeResponse(db: D1Database, request: Request): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  let body: BridgeRequest;
  try {
    body = (await request.json()) as BridgeRequest;
  } catch {
    return Response.json({ error: 'bad json' }, { status: 400 });
  }
  const out = await runQuery(db, body);
  return Response.json(out, { status: out.error ? 400 : 200 });
}
