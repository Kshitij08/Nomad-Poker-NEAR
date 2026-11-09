/**
 * The PER lobby's read routes, served by the Worker straight from D1 (the most frequent requests: the game polls the
 * lobby). Same responses as the container's Express routes (container/src/api.ts tableRow / handRow), which wrote
 * them from node-postgres rows: bigint columns as strings, booleans as booleans, timestamps as ISO strings.
 */

type Row = Record<string, unknown>;

const str = (v: unknown) => (v == null ? v : String(v));
const bool = (v: unknown) => v === 1 || v === true;

export function tableRow(r: Row) {
  return {
    address: r.address,
    tableId: r.table_id,
    creator: r.creator,
    open: r.status === 1,
    maxSeats: r.max_seats,
    seated: r.seated,
    live: r.status === 1 && bool(r.delegated),
    inviteOnly: bool(r.invite_only),
    smallBlind: str(r.small_blind),
    bigBlind: str(r.big_blind),
    minBuyIn: str(r.min_buy_in),
    maxBuyIn: str(r.max_buy_in),
    handNo: str(r.hand_no),
    updatedAt: r.updated_at,
  };
}

const json = (v: unknown) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

export function handRow(r: Row) {
  return {
    handNo: str(r.hand_no),
    record: json(r.record),
    verified: bool(r.verified),
    buttonChecked: r.button_checked !== 0 && r.button_checked !== false,
    problems: json(r.problems),
    log: { status: r.log_status, verified: r.log_verified == null ? null : bool(r.log_verified) },
    archivedAt: r.archived_at,
  };
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HAND_NO = /^[0-9]{1,18}$/;

/** GET /tables, /tables/:table, /tables/:table/hands; null for anything else (the container answers it). */
export async function lobbyRoute(db: D1Database, url: URL): Promise<Response | null> {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'tables' || parts.length > 3 || (parts.length === 3 && parts[2] !== 'hands')) return null;
  if (parts.length === 1) {
    const creator = url.searchParams.get('creator');
    if (creator !== null) {
      if (!BASE58.test(creator)) return Response.json({ error: 'bad creator address' }, { status: 400 });
      const r = await db.prepare('SELECT * FROM tables WHERE creator = ?1 ORDER BY first_seen DESC LIMIT 100').bind(creator).all<Row>();
      return Response.json(r.results.map(tableRow));
    }
    // Only tables that are playing, or opened / dealt a hand in the last hour (the container's rule).
    const r = await db
      .prepare('SELECT * FROM tables WHERE status = 1 AND delegated AND (hand_state <> 0 OR idle_since > unixepoch() - 3600) ORDER BY updated_at DESC LIMIT 200')
      .all<Row>();
    return Response.json(r.results.map(tableRow));
  }
  const table = parts[1]!;
  if (!BASE58.test(table)) return Response.json({ error: 'bad table address' }, { status: 400 });
  if (parts.length === 2) {
    const row = await db.prepare('SELECT * FROM tables WHERE address = ?1').bind(table).first<Row>();
    return row ? Response.json(tableRow(row)) : Response.json({ error: 'unknown table' }, { status: 404 });
  }
  const limitRaw = Math.trunc(Number(url.searchParams.get('limit') ?? 50));
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(limitRaw, 200) : 50;
  const before = url.searchParams.get('before');
  const r = await db
    .prepare(
      `SELECT table_address, hand_no, record, verified, problems, log_status, log_verified, button_checked, archived_at FROM hands
        WHERE table_address = ?1 AND (?2 IS NULL OR hand_no < ?2) ORDER BY hand_no DESC LIMIT ?3`,
    )
    .bind(table, before && HAND_NO.test(before) ? Number(before) : null, limit)
    .all<Row>();
  return Response.json(r.results.map(handRow));
}
