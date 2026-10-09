"use strict";
/*
 * Database access with two interchangeable backends:
 *
 *   - Turso (hosted libSQL, free tier) when TURSO_DATABASE_URL is set.
 *     Talks to Turso's HTTP API ("Hrana over HTTP", POST /v2/pipeline)
 *     with plain fetch, so there are no npm dependencies.
 *   - A local SQLite file via node:sqlite otherwise.
 *
 * Both expose the same async interface: all(sql, args) returns rows as
 * plain objects, run(sql, args) executes a statement, and ready resolves
 * once the schema exists.
 */
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = [
  // One row per guess. `player` is an anonymous browser id or an account's player id.
  `CREATE TABLE IF NOT EXISTS plays (
    day        INTEGER NOT NULL,
    q          INTEGER NOT NULL,
    player     TEXT    NOT NULL,
    guess      REAL    NOT NULL,
    offset     REAL    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (day, q, player)
  )`,
  "CREATE INDEX IF NOT EXISTS plays_player ON plays (player, day)",
  `CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    username       TEXT NOT NULL,
    username_lower TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    player         TEXT NOT NULL UNIQUE,
    created_at     INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)",
  // Player-submitted question ideas and general feedback, read by the site owner.
  `CREATE TABLE IF NOT EXISTS suggestions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT,
    question   TEXT NOT NULL,
    answer     TEXT NOT NULL,
    unit       TEXT,
    source     TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS feedback (
    id         TEXT PRIMARY KEY,
    user_id    TEXT,
    message    TEXT NOT NULL,
    contact    TEXT,
    created_at INTEGER NOT NULL
  )`,
];

/* ---------------- Local SQLite ---------------- */
function localStore(file) {
  const { DatabaseSync } = require("node:sqlite");
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  for (const s of SCHEMA) db.exec(s);
  const cache = new Map();
  const prep = (sql) => cache.get(sql) || cache.set(sql, db.prepare(sql)).get(sql);
  return {
    kind: "sqlite",
    ready: Promise.resolve(),
    all: async (sql, args = []) => prep(sql).all(...args).map((r) => ({ ...r })),
    run: async (sql, args = []) => { prep(sql).run(...args); },
    close: () => db.close(),
  };
}

/* ---------------- Turso over HTTP ---------------- */
function encodeArg(v) {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "string") return { type: "text", value: v };
  if (Number.isInteger(v)) return { type: "integer", value: String(v) };
  return { type: "float", value: v };
}
function decodeValue(v) {
  switch (v.type) {
    case "null": return null;
    case "integer": return Number(v.value);
    case "float": return Number(v.value);
    default: return v.value; // text (blobs are never stored here)
  }
}

function tursoStore(url, token, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const endpoint = url.replace(/^libsql:\/\//, "https://").replace(/\/+$/, "") + "/v2/pipeline";

  async function pipeline(stmts) {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        requests: [
          ...stmts.map(([sql, args = []]) => ({ type: "execute", stmt: { sql, args: args.map(encodeArg) } })),
          { type: "close" },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Turso HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    return body.results.slice(0, stmts.length).map((r) => {
      if (r.type !== "ok") throw new Error(`Turso error: ${r.error?.message || "unknown"}`);
      const { cols, rows } = r.response.result;
      return rows.map((row) => Object.fromEntries(cols.map((c, i) => [c.name, decodeValue(row[i])])));
    });
  }

  const ready = pipeline(SCHEMA.map((s) => [s]));
  return {
    kind: "turso",
    ready,
    all: async (sql, args) => { await ready; return (await pipeline([[sql, args]]))[0]; },
    run: async (sql, args) => { await ready; await pipeline([[sql, args]]); },
    close: () => {},
  };
}

function openStore({ dbPath, tursoUrl, tursoToken, fetchImpl }) {
  if (tursoUrl) return tursoStore(tursoUrl, tursoToken, { fetchImpl });
  return localStore(dbPath);
}

module.exports = { openStore, tursoStore, localStore, SCHEMA };
