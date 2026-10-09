"use strict";
/*
 * Ballpark server: serves the static site, records guesses so the
 * "how everyone guessed" charts use real player data, and handles
 * accounts so a player's stats follow them across devices.
 *
 *   PORT                (default 3000)
 *   TURSO_DATABASE_URL  hosted libSQL database (free tier); when set, data goes there
 *   TURSO_AUTH_TOKEN    its auth token
 *   DB_PATH             local SQLite file otherwise (default ./data/ballpark.db; ":memory:" for tests)
 *   TRUST_PROXY         set behind a reverse proxy (Render etc.)
 *
 * No dependencies; requires Node >= 22.5 for node:sqlite.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { openStore } = require("./store.js");
const Puzzle = require("./js/puzzle.js");

const ROOT = __dirname;
const HIST_BINS = 21;
const Q_RANGE = [-1, 1]; // per-question histogram: answer/10 .. answer*10 (log10 offsets)
const DAY_RANGE = [0, 3]; // daily score histogram: 1x .. 1,000x (log10)
const MAX_BODY = 2048;
const SESSION_COOKIE = "bp_session";
const SESSION_DAYS = 90;

/* ---------------- Errors & validation ---------------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const PLAYER_RE = /^[A-Za-z0-9-]{8,64}$/;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

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
  if (!Number.isFinite(g) || g <= 0 || g > 1e100) throw new HttpError(400, "invalid guess");
  return g;
}
function validUsername(v) {
  if (typeof v !== "string" || !USERNAME_RE.test(v)) {
    throw new HttpError(400, "Usernames are 3–20 characters: letters, numbers and underscores.");
  }
  return v;
}
function validPassword(v) {
  if (typeof v !== "string" || v.length < 8) throw new HttpError(400, "Passwords need at least 8 characters.");
  if (v.length > 200) throw new HttpError(400, "That password is too long (200 characters max).");
  return v;
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

async function questionStats(db, day, q, player) {
  const rows = await db.all("SELECT player, offset FROM plays WHERE day = ? AND q = ?", [day, q]);
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

async function dayStats(db, day, player) {
  const rows = await db.all(
    `SELECT player, AVG(ABS(offset)) AS score FROM plays WHERE day = ?
     GROUP BY player HAVING COUNT(*) = ${Puzzle.PER_DAY}`, [day]);
  const mine = rows.find((r) => r.player === player);
  const out = { count: rows.length, range: DAY_RANGE, bins: histogram(rows.map((r) => r.score), DAY_RANGE) };
  if (mine) {
    out.score = Math.pow(10, mine.score);
    // "Top X%": share of finishers who scored as well or better (lower is better), including you.
    out.top = Math.max(1, Math.ceil((rows.filter((r) => r.score <= mine.score + 1e-12).length / rows.length) * 100));
  }
  return out;
}

// A player's full history plus summary stats (for accounts).
async function playerSummary(db, player) {
  const rows = await db.all("SELECT day, q, guess, offset FROM plays WHERE player = ? ORDER BY day", [player]);
  const days = new Map();
  for (const r of rows) {
    if (!days.has(r.day)) days.set(r.day, { guesses: [], offsets: [] });
    const d = days.get(r.day);
    d.guesses[r.q] = r.guess;
    d.offsets[r.q] = r.offset;
  }
  const history = [];
  const finished = [];
  for (const [day, d] of days) {
    const guesses = Array.from({ length: Puzzle.PER_DAY }, (_, i) => d.guesses[i] ?? null);
    const done = guesses.every((g) => g != null);
    const score = done ? Math.pow(10, d.offsets.reduce((s, o) => s + Math.abs(o), 0) / Puzzle.PER_DAY) : null;
    history.push({ day, guesses, score });
    if (done) finished.push({ day, score });
  }
  let maxStreak = 0;
  let run = 0;
  finished.forEach((f, i) => {
    run = i && f.day === finished[i - 1].day + 1 ? run + 1 : 1;
    maxStreak = Math.max(maxStreak, run);
  });
  const doneDays = new Set(finished.map((f) => f.day));
  const today = Puzzle.today();
  let streak = 0;
  for (let n = doneDays.has(today) ? today : today - 1; doneDays.has(n); n--) streak++;
  const logs = finished.map((f) => Math.log10(f.score));
  return {
    history,
    stats: {
      played: finished.length,
      average: logs.length ? Math.pow(10, logs.reduce((a, b) => a + b, 0) / logs.length) : null,
      best: finished.length ? Math.min(...finished.map((f) => f.score)) : null,
      streak,
      maxStreak,
    },
  };
}

function record(db, day, q, player, guess) {
  const answer = Puzzle.puzzleFor(day)[q].a;
  return db.run(
    // First guess wins: a player can't overwrite an earlier answer.
    "INSERT OR IGNORE INTO plays (day, q, player, guess, offset, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [day, q, player, guess, Math.log10(guess / answer), Date.now()]);
}

/* ---------------- Passwords & sessions ---------------- */
const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
async function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored).split("$");
  if (scheme !== "scrypt") return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, SCRYPT);
  return crypto.timingSafeEqual(key, expected);
}
// Checked against when a username doesn't exist, so failed logins take the same time either way.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString("hex"));

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  await db.run("DELETE FROM sessions WHERE expires_at < ?", [now]); // housekeeping
  await db.run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    [sha256(token), userId, now + SESSION_DAYS * 864e5]);
  return token;
}

async function sessionUser(db, req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || token.length > 100) return null;
  const rows = await db.all(
    `SELECT u.id, u.username, u.player, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`, [sha256(token), Date.now()]);
  return rows[0] ? { ...rows[0], token } : null;
}

// Rolling sessions: when a signed-in player visits and their session has been
// running for over a day, push its expiry back out to the full 90 days.
const RENEW_AFTER_MS = 864e5;
async function renewSession(db, req, res, user, trustProxy) {
  const fresh = Date.now() + SESSION_DAYS * 864e5;
  if (fresh - user.expires_at < RENEW_AFTER_MS) return;
  await db.run("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", [fresh, sha256(user.token)]);
  setSessionCookie(res, req, user.token, trustProxy);
}

function setSessionCookie(res, req, token, trustProxy) {
  const secure = req.socket.encrypted || (trustProxy && String(req.headers["x-forwarded-proto"]).startsWith("https"));
  const parts = [
    `${SESSION_COOKIE}=${token || ""}`, "Path=/", "HttpOnly", "SameSite=Lax",
    `Max-Age=${token ? SESSION_DAYS * 86400 : 0}`,
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

async function accountView(db, user) {
  return { user: { username: user.username }, player: user.player, ...(await playerSummary(db, user.player)) };
}

// The player id a request acts as: a signed-in account always uses its own;
// an anonymous browser may not use an id that belongs to an account.
async function resolvePlayer(db, req, claimed) {
  const user = await sessionUser(db, req);
  if (user) return user.player;
  const player = validPlayer(claimed);
  const owner = await db.all("SELECT 1 FROM users WHERE player = ?", [player]);
  if (owner.length) throw new HttpError(401, "Sign in to keep playing on this account.");
  return player;
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
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch { reject(new HttpError(400, "invalid JSON")); }
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

// A fingerprint of every asset, stamped into index.html's asset URLs (?v=...). Each deploy
// changes the URLs, so browsers fetch fresh CSS/JS instead of a cached older copy.
const ASSET_VERSION = (() => {
  const h = crypto.createHash("sha256");
  for (const dir of PUBLIC_DIRS) {
    for (const name of fs.readdirSync(path.join(ROOT, dir)).sort()) h.update(name).update(fs.readFileSync(path.join(ROOT, dir, name)));
  }
  return h.digest("hex").slice(0, 12);
})();
let indexHtml = null;

function serveStatic(req, res, pathname, versioned) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new HttpError(400, "bad path"); }
  const file = path.resolve(ROOT, "." + (decoded === "/" ? "/index.html" : decoded));
  const rel = path.relative(ROOT, file);
  // Only the page itself and the asset folders are public (never server.js, data/, .git, ...).
  if (rel !== "index.html" && !PUBLIC_DIRS.some((d) => rel.startsWith(d + path.sep))) return notFound(res);
  if (rel === "index.html") {
    indexHtml = indexHtml || Buffer.from(fs.readFileSync(file, "utf8").replace(/__V__/g, ASSET_VERSION));
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": MIME[".html"], "Content-Length": indexHtml.length, "Cache-Control": "no-cache" });
    return res.end(req.method === "HEAD" ? undefined : indexHtml);
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Content-Length": st.size,
      // Versioned URLs never change content, so they can be cached for good; anything else is rechecked.
      "Cache-Control": versioned ? "public, max-age=31536000, immutable" : "no-cache",
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
async function handleApi(req, res, url, db, ctx) {
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    // Record one guess; returns that question's crowd stats.
    case "POST /api/guess": {
      const body = await readJson(req);
      const day = validDay(body.day), q = validQ(body.q), guess = validGuess(body.guess);
      const player = await resolvePlayer(db, req, body.player);
      await record(db, day, q, player, guess);
      return sendJson(res, 200, await questionStats(db, day, q, player));
    }
    // Record all of a player's guesses for a day (idempotent sync); returns day + per-question stats.
    case "POST /api/day": {
      const body = await readJson(req);
      const day = validDay(body.day);
      if (!Array.isArray(body.guesses) || body.guesses.length > Puzzle.PER_DAY) throw new HttpError(400, "invalid guesses");
      const guesses = body.guesses.map((g) => (g == null ? null : validGuess(g)));
      const player = await resolvePlayer(db, req, body.player);
      for (const [q, g] of guesses.entries()) if (g != null) await record(db, day, q, player, g);
      return sendJson(res, 200, {
        day: await dayStats(db, day, player),
        questions: await Promise.all([0, 1, 2].map((q) => questionStats(db, day, q, player))),
      });
    }
    case "GET /api/question": {
      const day = validDay(url.searchParams.get("day")), q = validQ(url.searchParams.get("q"));
      const user = await sessionUser(db, req);
      const player = user ? user.player : url.searchParams.get("player") || "";
      return sendJson(res, 200, await questionStats(db, day, q, player));
    }

    /* ----- Accounts ----- */
    case "POST /api/signup": {
      if (!ctx.allowAuth()) throw new HttpError(429, "Too many attempts. Wait a minute and try again.");
      const body = await readJson(req);
      const username = validUsername(body.username), password = validPassword(body.password);
      const lower = username.toLowerCase();
      if ((await db.all("SELECT 1 FROM users WHERE username_lower = ?", [lower])).length) {
        throw new HttpError(409, "That username is taken.");
      }
      // Keep this browser's anonymous history by adopting its player id, unless it's already an account's.
      let player = PLAYER_RE.test(String(body.player || "")) ? body.player : null;
      if (player && (await db.all("SELECT 1 FROM users WHERE player = ?", [player])).length) player = null;
      player = player || crypto.randomUUID();
      const id = crypto.randomUUID();
      try {
        await db.run("INSERT INTO users (id, username, username_lower, password_hash, player, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [id, username, lower, await hashPassword(password), player, Date.now()]);
      } catch (err) {
        if (/unique/i.test(err.message)) throw new HttpError(409, "That username is taken.");
        throw err;
      }
      setSessionCookie(res, req, await createSession(db, id), ctx.trustProxy);
      return sendJson(res, 200, await accountView(db, { id, username, player }));
    }
    case "POST /api/login": {
      if (!ctx.allowAuth()) throw new HttpError(429, "Too many attempts. Wait a minute and try again.");
      const body = await readJson(req);
      const username = String(body.username || "").slice(0, 40), password = String(body.password || "").slice(0, 200);
      const [user] = await db.all("SELECT id, username, password_hash, player FROM users WHERE username_lower = ?", [username.toLowerCase()]);
      const ok = await verifyPassword(password, user ? user.password_hash : await DUMMY_HASH);
      if (!user || !ok) throw new HttpError(401, "Wrong username or password.");
      // Fold in anything this browser played while signed out (the account's earlier answers win).
      const anon = String(body.player || "");
      if (PLAYER_RE.test(anon) && anon !== user.player && !(await db.all("SELECT 1 FROM users WHERE player = ?", [anon])).length) {
        await db.run(
          `INSERT OR IGNORE INTO plays (day, q, player, guess, offset, created_at)
           SELECT day, q, ?, guess, offset, created_at FROM plays WHERE player = ?`, [user.player, anon]);
        await db.run("DELETE FROM plays WHERE player = ?", [anon]);
      }
      setSessionCookie(res, req, await createSession(db, user.id), ctx.trustProxy);
      return sendJson(res, 200, await accountView(db, user));
    }
    case "POST /api/logout": {
      const token = parseCookies(req)[SESSION_COOKIE];
      if (token) await db.run("DELETE FROM sessions WHERE token_hash = ?", [sha256(token)]);
      setSessionCookie(res, req, "", ctx.trustProxy);
      return sendJson(res, 200, { ok: true });
    }
    case "GET /api/me": {
      const user = await sessionUser(db, req);
      if (user) await renewSession(db, req, res, user, ctx.trustProxy);
      return sendJson(res, 200, user ? await accountView(db, user) : { user: null });
    }

    case "GET /api/health":
      return sendJson(res, 200, { ok: true, today: Puzzle.today() });
    default:
      throw new HttpError(404, "not found");
  }
}

function createServer({
  dbPath = process.env.DB_PATH || path.join(ROOT, "data", "ballpark.db"),
  tursoUrl = process.env.TURSO_DATABASE_URL,
  tursoToken = process.env.TURSO_AUTH_TOKEN,
  fetchImpl,
  trustProxy = !!process.env.TRUST_PROXY,
} = {}) {
  const db = openStore({ dbPath, tursoUrl, tursoToken, fetchImpl });
  db.ready.then(
    () => console.log(`Storage: ${db.kind === "turso" ? "Turso" : "local SQLite at " + dbPath}`),
    (err) => console.error("Storage failed to initialise:", err.message)
  );
  const allow = rateLimiter();
  const authLimit = rateLimiter({ capacity: 10, refillPerSec: 1 / 6 }); // 10 tries, then 1 every 6 s
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        const ip = (trustProxy && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress;
        if (!allow(ip)) throw new HttpError(429, "slow down");
        return await handleApi(req, res, url, db, { trustProxy, allowAuth: () => authLimit(ip) });
      }
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
      return serveStatic(req, res, url.pathname, url.searchParams.get("v") === ASSET_VERSION);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (status === 413) res.setHeader("Connection", "close");
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? "server error" : err.message });
    }
  });
  server.on("close", () => db.close());
  Object.defineProperty(server, "__db", { value: db }); // for tests
  return server;
}

module.exports = { createServer };

// In a container we start as root only so a freshly mounted (root-owned) volume
// can be handed to RUN_AS; then we drop privileges before opening the database.
function dropPrivileges(dbPath) {
  const user = process.env.RUN_AS;
  if (!user || typeof process.getuid !== "function" || process.getuid() !== 0) return;
  const { execFileSync } = require("node:child_process");
  const uid = Number(execFileSync("id", ["-u", user]).toString().trim());
  const gid = Number(execFileSync("id", ["-g", user]).toString().trim());
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of [dir, ...fs.readdirSync(dir).map((n) => path.join(dir, n))]) fs.chownSync(f, uid, gid);
  process.setgid(gid);
  process.setuid(uid);
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  dropPrivileges(process.env.DB_PATH || path.join(ROOT, "data", "ballpark.db"));
  const server = createServer().listen(port, () => console.log(`Ballpark running at http://localhost:${port}`));
  // Hosts stop containers with SIGTERM; close the database cleanly so the WAL is checkpointed.
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      server.close(() => process.exit(0));
      server.closeAllConnections();
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}
