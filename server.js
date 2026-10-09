"use strict";
/*
 * Ballpark server: serves the static site and records guesses so the
 * "how everyone guessed" charts use real player data.
 *
 *   PORT     (default 3000)
 *   DB_PATH  (default ./data/ballpark.db; use ":memory:" for tests)
 *
 * No dependencies; requires Node >= 22.5 for node:sqlite.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const Puzzle = require("./js/puzzle.js");

const ROOT = __dirname;
const HIST_BINS = 21;
const Q_RANGE = [-1, 1]; // per-question histogram: answer/10 .. answer*10 (log10 offsets)
const DAY_RANGE = [0, 3]; // daily score histogram: 1x .. 1,000x (log10)
const MAX_BODY = 2048;

/* ---------------- Database ---------------- */
function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS guesses (
      day        INTEGER NOT NULL,
      q          INTEGER NOT NULL,
      player     TEXT    NOT NULL,
      guess      REAL    NOT NULL,
      offset     REAL    NOT NULL,   -- log10(guess / answer)
      created_at INTEGER NOT NULL,
      PRIMARY KEY (day, q, player)
    );
    CREATE INDEX IF NOT EXISTS guesses_day ON guesses (day, q);
  `);
  return {
    // First guess wins: a player can't overwrite an earlier answer.
    insert: db.prepare("INSERT OR IGNORE INTO guesses (day, q, player, guess, offset, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
    offsets: db.prepare("SELECT player, offset FROM guesses WHERE day = ? AND q = ?"),
    dayScores: db.prepare(`
      SELECT player, AVG(ABS(offset)) AS score
      FROM guesses WHERE day = ?
      GROUP BY player HAVING COUNT(*) = ${Puzzle.PER_DAY}`),
    close: () => db.close(),
  };
}

/* ---------------- Stats ---------------- */
function histogram(values, [lo, hi]) {
  const bins = new Array(HIST_BINS).fill(0);
  for (const v of values) {
    const k = Math.floor(((v - lo) / (hi - lo)) * HIST_BINS);
    bins[Math.min(HIST_BINS - 1, Math.max(0, k))]++; // clamp outliers into the end bins
  }
  return bins;
}

function questionStats(db, day, q, player) {
  const rows = db.offsets.all(day, q);
  const mine = rows.find((r) => r.player === player);
  const others = rows.filter((r) => r.player !== player);
  const out = { count: rows.length, range: Q_RANGE, bins: histogram(rows.map((r) => r.offset), Q_RANGE) };
  if (mine) {
    out.offset = mine.offset;
    out.closerThan = others.length
      ? Math.round((others.filter((r) => Math.abs(r.offset) > Math.abs(mine.offset)).length / others.length) * 100)
      : null;
  }
  return out;
}

function dayStats(db, day, player) {
  const rows = db.dayScores.all(day);
  const mine = rows.find((r) => r.player === player);
  const out = { count: rows.length, range: DAY_RANGE, bins: histogram(rows.map((r) => r.score), DAY_RANGE) };
  if (mine) {
    out.score = Math.pow(10, mine.score);
    // "Top X%": share of finishers who scored as well or better (lower is better), including you.
    out.top = Math.max(1, Math.ceil((rows.filter((r) => r.score <= mine.score + 1e-12).length / rows.length) * 100));
  }
  return out;
}

/* ---------------- Validation ---------------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const PLAYER_RE = /^[A-Za-z0-9-]{8,64}$/;

function validDay(v) {
  const day = Number(v);
  if (!Number.isInteger(day) || day < 1 || day > Puzzle.today()) throw new HttpError(400, "invalid day");
  return day;
}
function validQ(v) {
  const q = Number(v);
  if (!Number.isInteger(q) || q < 0 || q >= Puzzle.PER_DAY) throw new HttpError(400, "invalid question");
  return q;
}
function validPlayer(v) {
  if (typeof v !== "string" || !PLAYER_RE.test(v)) throw new HttpError(400, "invalid player");
  return v;
}
function validGuess(v) {
  const g = Number(v);
  if (!Number.isFinite(g) || g <= 0 || g > 1e18) throw new HttpError(400, "invalid guess");
  return g;
}

function record(db, day, q, player, guess) {
  const answer = Puzzle.puzzleFor(day)[q].a;
  db.insert.run(day, q, player, guess, Math.log10(guess / answer), Date.now());
}

/* ---------------- Rate limiting (per IP, in memory) ---------------- */
function rateLimiter({ capacity = 60, refillPerSec = 1 } = {}) {
  const buckets = new Map();
  setInterval(() => {
    const cutoff = Date.now() - 10 * 60e3;
    for (const [ip, b] of buckets) if (b.t < cutoff) buckets.delete(ip);
  }, 60e3).unref();
  return (ip) => {
    const now = Date.now();
    const b = buckets.get(ip) || { tokens: capacity, t: now };
    b.tokens = Math.min(capacity, b.tokens + ((now - b.t) / 1000) * refillPerSec);
    b.t = now;
    buckets.set(ip, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

/* ---------------- HTTP helpers ---------------- */
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": [
    "default-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) return reject(new HttpError(415, "expected application/json"));
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      if (size > MAX_BODY) return; // already rejected; drain the rest
      size += c.length;
      if (size > MAX_BODY) return reject(new HttpError(413, "body too large"));
      chunks.push(c);
    });
    req.on("end", () => {
      if (size > MAX_BODY) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new HttpError(400, "invalid JSON")); }
    });
    req.on("error", reject);
  });
}

/* ---------------- Static files ---------------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const PUBLIC_DIRS = ["css", "js"];

function serveStatic(req, res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new HttpError(400, "bad path"); }
  const file = path.resolve(ROOT, "." + (decoded === "/" ? "/index.html" : decoded));
  const rel = path.relative(ROOT, file);
  // Only the page itself and the asset folders are public (never server.js, data/, .git, ...).
  if (rel !== "index.html" && !PUBLIC_DIRS.some((d) => rel.startsWith(d + path.sep))) return notFound(res);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": rel === "index.html" ? "no-cache" : "public, max-age=300",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}
function notFound(res) {
  res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

/* ---------------- API ---------------- */
async function handleApi(req, res, url, db) {
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    // Record one guess; returns that question's crowd stats.
    case "POST /api/guess": {
      const body = await readJson(req);
      const day = validDay(body.day), q = validQ(body.q), player = validPlayer(body.player), guess = validGuess(body.guess);
      record(db, day, q, player, guess);
      return sendJson(res, 200, questionStats(db, day, q, player));
    }
    // Record all of a player's guesses for a day (idempotent sync); returns day + per-question stats.
    case "POST /api/day": {
      const body = await readJson(req);
      const day = validDay(body.day), player = validPlayer(body.player);
      if (!Array.isArray(body.guesses) || body.guesses.length > Puzzle.PER_DAY) throw new HttpError(400, "invalid guesses");
      body.guesses.forEach((g, q) => { if (g != null) record(db, day, q, player, validGuess(g)); });
      return sendJson(res, 200, {
        day: dayStats(db, day, player),
        questions: [0, 1, 2].map((q) => questionStats(db, day, q, player)),
      });
    }
    case "GET /api/question": {
      const day = validDay(url.searchParams.get("day")), q = validQ(url.searchParams.get("q"));
      const player = url.searchParams.get("player") || "";
      return sendJson(res, 200, questionStats(db, day, q, player));
    }
    case "GET /api/health":
      return sendJson(res, 200, { ok: true, today: Puzzle.today() });
    default:
      throw new HttpError(404, "not found");
  }
}

function createServer({ dbPath = process.env.DB_PATH || path.join(ROOT, "data", "ballpark.db"), trustProxy = !!process.env.TRUST_PROXY } = {}) {
  const db = openDb(dbPath);
  const allow = rateLimiter();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        const ip = (trustProxy && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress;
        if (!allow(ip)) throw new HttpError(429, "slow down");
        return await handleApi(req, res, url, db);
      }
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (status === 413) res.setHeader("Connection", "close");
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? "server error" : err.message });
    }
  });
  server.on("close", () => db.close());
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => console.log(`Ballpark running at http://localhost:${port}`));
}
