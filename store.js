"use strict";
/*
 * Guess storage with two interchangeable backends:
 *
 *   - Turso (hosted libSQL, free tier) when TURSO_DATABASE_URL is set.
 *     Talks to Turso's HTTP API ("Hrana over HTTP", POST /v2/pipeline)
 *     with plain fetch, so there are no npm dependencies.
 *   - A local SQLite file via node:sqlite otherwise.
 *
 * Both expose the same async interface.
 */
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS guesses (
    day        INTEGER NOT NULL,
    q          INTEGER NOT NULL,
    player     TEXT    NOT NULL,
    guess      REAL    NOT NULL,
    offset     REAL    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (day, q, player)
  )`,
  "CREATE INDEX IF NOT EXISTS guesses_day ON guesses (day, q)",
];
const SQL = {
  // First guess wins: a player can't overwrite an earlier answer.
  insert: "INSERT OR IGNORE INTO guesses (day, q, player, guess, offset, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  offsets: "SELECT player, offset FROM guesses WHERE day = ? AND q = ?",
  dayScores: (perDay) => `SELECT player, AVG(ABS(offset)) AS score FROM guesses WHERE day = ? GROUP BY player HAVING COUNT(*) = ${perDay}`,
};

/* ---------------- Local SQLite ---------------- */
function localStore(file, perDay) {
  const { DatabaseSync } = require("node:sqlite");
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  for (const s of SCHEMA) db.exec(s);
  const insert = db.prepare(SQL.insert);
  const offsets = db.prepare(SQL.offsets);
  const dayScores = db.prepare(SQL.dayScores(perDay));
  return {
    kind: "sqlite",
    ready: Promise.resolve(),
    insert: async (...args) => { insert.run(...args); },
    offsets: async (day, q) => offsets.all(day, q),
    dayScores: async (day) => dayScores.all(day),
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

function tursoStore(url, token, perDay, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
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
  const one = async (sql, args) => (await pipeline([[sql, args]]))[0];

  const ready = pipeline(SCHEMA.map((s) => [s]));
  return {
    kind: "turso",
    ready,
    insert: async (...args) => { await ready; await one(SQL.insert, args); },
    offsets: async (day, q) => { await ready; return one(SQL.offsets, [day, q]); },
    dayScores: async (day) => { await ready; return one(SQL.dayScores(perDay), [day]); },
    close: () => {},
  };
}

function openStore({ dbPath, tursoUrl, tursoToken, perDay, fetchImpl }) {
  if (tursoUrl) return tursoStore(tursoUrl, tursoToken, perDay, { fetchImpl });
  return localStore(dbPath, perDay);
}

module.exports = { openStore, tursoStore, localStore, SCHEMA };
