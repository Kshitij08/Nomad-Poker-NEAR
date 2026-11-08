import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The slice of the D1 API the Worker uses, over Node's built-in SQLite (same engine as D1), so tests exercise the
 * real SQL, constraints and triggers. Batches run in one transaction, like D1's.
 */

type Row = Record<string, unknown>;
interface SqliteStmt {
  all(...p: unknown[]): Row[];
  run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  columns?(): { name: string }[];
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmt;
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDb };

const RETURNS_ROWS = /^\s*(SELECT|WITH|PRAGMA)|\bRETURNING\b/i;

class Stmt {
  constructor(
    private readonly db: SqliteDb,
    readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): Stmt {
    return new Stmt(this.db, this.sql, params);
  }

  private exec(): { results: Row[]; changes: number; lastRowId: number } {
    // D1 numbers its parameters (?1, ?2, ?1 again…); node:sqlite treats ?N as named, so rewrite them to plain ?
    // and expand the values in order of appearance.
    const values = this.params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));
    const params: unknown[] = [];
    let next = 0;
    const sql = this.sql.replace(/\?(\d*)/g, (_m, n: string) => {
      params.push(values[n ? Number(n) - 1 : next++]);
      return '?';
    });
    const s = this.db.prepare(sql);
    if (RETURNS_ROWS.test(this.sql)) {
      const results = s.all(...params).map((r) => ({ ...r }));
      return { results, changes: results.length, lastRowId: 0 };
    }
    const r = s.run(...params);
    return { results: [], changes: Number(r.changes), lastRowId: Number(r.lastInsertRowid) };
  }

  async first<T>(col?: string): Promise<T | null> {
    const row = this.exec().results[0];
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }

  async all<T>(): Promise<D1Result<T>> {
    return this.result<T>(this.exec());
  }

  async run<T>(): Promise<D1Result<T>> {
    return this.result<T>(this.exec());
  }

  runInBatch<T>(): D1Result<T> {
    return this.result<T>(this.exec());
  }

  private result<T>(r: { results: Row[]; changes: number; lastRowId: number }): D1Result<T> {
    return {
      success: true,
      results: r.results as T[],
      meta: { changes: r.changes, last_row_id: r.lastRowId, duration: 0 } as D1Result['meta'],
    };
  }
}

export class D1Shim {
  readonly sqlite: SqliteDb;

  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
  }

  /** Applies every migration in apps/api/migrations, in order. */
  static async migrated(): Promise<D1Database> {
    const shim = new D1Shim();
    const dir = join(import.meta.dirname, '..', '..', 'migrations');
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) shim.sqlite.exec(readFileSync(join(dir, f), 'utf8'));
    return shim as unknown as D1Database;
  }

  prepare(sql: string): Stmt {
    return new Stmt(this.sqlite, sql);
  }

  async batch<T>(stmts: Stmt[]): Promise<D1Result<T>[]> {
    this.sqlite.exec('BEGIN');
    try {
      const out = stmts.map((s) => s.runInBatch<T>());
      this.sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }
}
