// Storage layer. Default: a local SQLite file (data/eks-lens.db) using Node's built-in
// node:sqlite, so there is nothing to install. Set DATABASE_URL=postgres://... to use
// PostgreSQL instead; the schema and queries are written to run unchanged on both.
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     account_id TEXT,
     auth_type TEXT NOT NULL,            -- keys | profile | default
     profile TEXT,
     access_key_id TEXT,
     secret_enc TEXT,                    -- AES-256-GCM encrypted secret access key
     session_token_enc TEXT,
     role_arn TEXT,                      -- optional role to assume after signing in
     external_id TEXT,
     regions TEXT NOT NULL,              -- JSON array, or ["all"]
     clusters TEXT,                      -- JSON array or NULL (auto-discover)
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS price_cache (
     price_key TEXT PRIMARY KEY,         -- od:<region>:<type> | spot:<az>:<type>
     price REAL NOT NULL,
     source TEXT NOT NULL,
     fetched_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cost_snapshots (
     ts TEXT NOT NULL,                   -- hour bucket, ISO UTC
     cluster_id TEXT NOT NULL,
     namespace TEXT NOT NULL,
     hourly REAL NOT NULL,
     cpu_req REAL, cpu_used REAL, mem_req_gib REAL, mem_used_gib REAL,
     pods INTEGER,
     PRIMARY KEY (ts, cluster_id, namespace))`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     ts TEXT NOT NULL,
     user_name TEXT,
     event TEXT NOT NULL,
     cluster_id TEXT,
     detail TEXT)`,
  `CREATE INDEX IF NOT EXISTS audit_ts ON audit_log (ts)`,
];

let impl = null;

async function openPostgres(url) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  return {
    dialect: 'postgres',
    async all(sql, params = []) { return (await pool.query(sql, params)).rows; },
    async run(sql, params = []) { await pool.query(sql, params); },
  };
}

async function openSqlite(file) {
  // node:sqlite prints an ExperimentalWarning on load; silence only that one.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...a));
  const { DatabaseSync } = await import('node:sqlite');
  process.emitWarning = emit;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  const toQ = (sql) => sql.replace(/\$\d+/g, '?');
  const plain = (r) => ({ ...r });
  const nul = (v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v);
  return {
    dialect: 'sqlite',
    file,
    async all(sql, params = []) { return db.prepare(toQ(sql)).all(...params.map(nul)).map(plain); },
    async run(sql, params = []) { db.prepare(toQ(sql)).run(...params.map(nul)); },
  };
}

export async function initDb() {
  const url = process.env.DATABASE_URL;
  impl = url && /^postgres(ql)?:/.test(url)
    ? await openPostgres(url)
    : await openSqlite(process.env.SQLITE_FILE || path.resolve('data/eks-lens.db'));
  for (const s of SCHEMA) await impl.run(s);
  return impl;
}

export const db = {
  all: (sql, params) => impl.all(sql, params),
  run: (sql, params) => impl.run(sql, params),
  get dialect() { return impl?.dialect; },
  get file() { return impl?.file; },
};
