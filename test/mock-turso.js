"use strict";
/*
 * A minimal stand-in for Turso's "Hrana over HTTP" endpoint (POST /v2/pipeline),
 * backed by an in-memory node:sqlite database. It mirrors the wire format:
 * typed args/values ({type: "integer", value: "1"}), per-request results with
 * {type: "ok", response: {type: "execute", result: {cols, rows, ...}}}, and
 * {type: "error", error: {message}} on failure.
 */
const http = require("node:http");
const { DatabaseSync } = require("node:sqlite");

function toValue(v) {
  if (v === null) return { type: "null" };
  if (typeof v === "bigint" || Number.isInteger(v)) return { type: "integer", value: String(v) };
  if (typeof v === "number") return { type: "float", value: v };
  return { type: "text", value: String(v) };
}
function fromArg(a) {
  switch (a.type) {
    case "null": return null;
    case "integer": return Number(a.value);
    case "float": return a.value;
    default: return a.value;
  }
}

async function mockTurso(token) {
  const db = new DatabaseSync(":memory:");
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v2/pipeline") { res.writeHead(404); return res.end(); }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end("unauthorized"); }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { requests } = JSON.parse(body);
      const results = requests.map((r) => {
        if (r.type === "close") return { type: "ok", response: { type: "close" } };
        try {
          const stmt = db.prepare(r.stmt.sql);
          const args = (r.stmt.args || []).map(fromArg);
          const cols = stmt.columns().map((c) => ({ name: c.name, decltype: c.type }));
          let rows = [];
          if (cols.length) rows = stmt.all(...args).map((row) => cols.map((c) => toValue(row[c.name])));
          else stmt.run(...args);
          return { type: "ok", response: { type: "execute", result: { cols, rows, affected_row_count: 0, last_insert_rowid: null } } };
        } catch (e) {
          return { type: "error", error: { message: e.message } };
        }
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ baton: null, base_url: null, results }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    // The client upgrades libsql:// to https://; route it back to this plain-HTTP mock.
    fetch: (u, opts) => fetch(String(u).replace(/^https:\/\/127\.0\.0\.1/, "http://127.0.0.1"), opts),
    close: () => new Promise((r) => { server.close(r); db.close(); }),
  };
}

module.exports = { mockTurso };
