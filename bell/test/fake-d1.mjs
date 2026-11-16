// fake-d1.mjs: a small stand-in for the Cloudflare D1 binding, on node:sqlite (owner W2).
// Shapes follow the D1 client API:
//   db.prepare(sql) -> statement; stmt.bind(...values) -> NEW bound statement;
//   stmt.first() -> first row object or null; stmt.first("col") -> that column of the first row or null
//   (throws when the column does not exist); stmt.all() / stmt.run() -> {success, results, meta};
//   stmt.raw() -> array of row arrays; db.batch([stmts]) -> array of results, all or nothing;
//   db.exec(sql) -> {count, duration}.
// Every call is async like the real binding. INSERT ... RETURNING rows come back in `results`.
// Test helpers (not part of D1): `statements` (number of statements executed, a batch of n counts n),
// `batches` (number of batch calls), `log` (SQL text of each executed statement), `args` (the bound values of
// each executed statement, same order as `log`), `resetCount()`, `failNext(n)` (the next n statement
// executions or batches throw a D1-style error), `failWhen(re)` (every statement whose SQL matches
// `re` throws; `re` may also be a function (sql, values) -> bool), `sql` (the raw node:sqlite DatabaseSync,
// for seeding and checking rows directly; not counted).

import { DatabaseSync } from "node:sqlite";

function d1Error(msg) {
  const err = new Error("D1_ERROR: " + msg);
  err.name = "Error";
  return err;
}

// D1 accepts null, numbers, strings, booleans (stored as 0/1) and byte arrays; anything else
// (undefined above all) is a type error.
function convertValue(v) {
  if (v === null) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw d1Error("D1_TYPE_ERROR: non-finite number");
    return v;
  }
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new Error("D1_TYPE_ERROR: Type '" + typeof v + "' not supported for value '" + String(v) + "'");
}

// Count "?" placeholders outside quoted text (enough for the plain SQL of this project).
function countPlaceholders(sql) {
  let n = 0;
  let quote = "";
  for (const ch of sql) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "?") {
      n++;
    }
  }
  return n;
}

function plainRow(row) {
  // node:sqlite rows have a null prototype; D1 rows are ordinary objects.
  return row ? { ...row } : row;
}

class FakeD1Statement {
  constructor(db, sql, params) {
    this._db = db;
    this._sql = sql;
    this._params = params;
  }

  bind(...values) {
    const params = values.map(convertValue);
    return new FakeD1Statement(this._db, this._sql, params);
  }

  async first(col) {
    const r = this._db._execOne(this);
    const row = r.results.length > 0 ? r.results[0] : null;
    if (col === undefined) return row;
    if (row === null) return null;
    if (!Object.prototype.hasOwnProperty.call(row, col)) throw d1Error("D1_COLUMN_NOTFOUND: Column not found (" + col + ")");
    return row[col];
  }

  async all() {
    return this._db._execOne(this);
  }

  async run() {
    return this._db._execOne(this);
  }

  async raw(opts) {
    const r = this._db._execOne(this);
    const rows = r.results.map((row) => Object.values(row));
    if (opts && opts.columnNames) {
      const names = r.results.length > 0 ? Object.keys(r.results[0]) : this._db._columnNames(this._sql);
      return [names, ...rows];
    }
    return rows;
  }
}

class FakeD1 {
  constructor() {
    this.sql = new DatabaseSync(":memory:");
    this.statements = 0;
    this.batches = 0;
    this.log = [];
    this.args = [];
    this._failCount = 0;
    this._failRe = null;
    this._totalChanges = this.sql.prepare("SELECT total_changes() AS c");
    this._lastRow = this.sql.prepare("SELECT last_insert_rowid() AS r");
  }

  prepare(sql) {
    if (typeof sql !== "string" || sql.trim() === "") throw d1Error("empty SQL");
    return new FakeD1Statement(this, sql, []);
  }

  async batch(stmts) {
    this.batches++;
    if (!Array.isArray(stmts) || stmts.length === 0) throw d1Error("batch needs at least one statement");
    for (const s of stmts) {
      if (!(s instanceof FakeD1Statement)) throw d1Error("batch takes prepared statements only");
    }
    if (this._failCount > 0) {
      this._failCount--;
      this.statements += stmts.length;
      throw d1Error("forced failure (batch)");
    }
    const out = [];
    this.sql.exec("BEGIN");
    try {
      for (const s of stmts) out.push(this._execOne(s, true));
      this.sql.exec("COMMIT");
    } catch (err) {
      this.sql.exec("ROLLBACK");
      throw err;
    }
    return out;
  }

  async exec(sqlText) {
    if (this._failCount > 0) {
      this._failCount--;
      throw d1Error("forced failure (exec)");
    }
    const parts = String(sqlText)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    for (const p of parts) {
      this.statements++;
      this.log.push(p);
      this.args.push([]);
      this.sql.exec(p);
    }
    return { count: parts.length, duration: 0 };
  }

  // ---- test helpers ----
  failNext(n = 1) {
    this._failCount = n;
  }

  failWhen(re) {
    this._failRe = re || null;
  }

  resetCount() {
    this.statements = 0;
    this.batches = 0;
    this.log = [];
    this.args = [];
  }

  close() {
    this.sql.close();
  }

  // ---- internals ----
  _columnNames(sql) {
    try {
      return this.sql.prepare(sql).columns().map((c) => c.name);
    } catch {
      return [];
    }
  }

  _execOne(stmt, inBatch = false) {
    this.statements++;
    this.log.push(stmt._sql);
    this.args.push(stmt._params.slice());
    if (!inBatch && this._failCount > 0) {
      this._failCount--;
      throw d1Error("forced failure");
    }
    if (this._failRe) {
      const hit = typeof this._failRe === "function" ? this._failRe(stmt._sql, stmt._params) : this._failRe.test(stmt._sql);
      if (hit) throw d1Error("forced failure (match)");
    }
    const want = countPlaceholders(stmt._sql);
    if (want !== stmt._params.length) {
      throw d1Error("Wrong number of parameter bindings for SQL query (want " + want + ", got " + stmt._params.length + ")");
    }
    let rows;
    const before = this._totalChanges.get().c;
    try {
      const st = this.sql.prepare(stmt._sql);
      rows = st.all(...stmt._params);
    } catch (err) {
      throw d1Error(err && err.message ? err.message : "sqlite error");
    }
    const changes = this._totalChanges.get().c - before;
    const results = rows.map(plainRow);
    return {
      success: true,
      results,
      meta: {
        duration: 0,
        changes,
        last_row_id: this._lastRow.get().r,
        changed_db: changes > 0,
        rows_read: results.length,
        rows_written: changes,
        size_after: 0,
      },
    };
  }
}

function makeFakeD1() {
  return new FakeD1();
}

export { FakeD1, makeFakeD1 };
