"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../server.js");
const Puzzle = require("../js/puzzle.js");

const { mockTurso } = require("./mock-turso.js");

let server, base, turso;
const TODAY = Puzzle.today();
const answers = Puzzle.puzzleFor(TODAY).map((p) => p.a);
// BACKEND=turso runs the same suite against the Turso HTTP client (via a protocol mock).
const BACKEND = process.env.BACKEND || "sqlite";

before(async () => {
  if (BACKEND === "turso") {
    turso = await mockTurso("secret-token");
    server = createServer({ tursoUrl: turso.url.replace("http://", "libsql://"), tursoToken: "secret-token", fetchImpl: turso.fetch });
  } else {
    server = createServer({ dbPath: ":memory:" });
  }
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  if (turso) await turso.close();
});

const post = (path, body, headers = { "Content-Type": "application/json" }) =>
  fetch(base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

test("serves the page and assets, but not server files", async () => {
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await fetch(base + "/js/app.js")).headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal((await fetch(base + "/css/style.css")).status, 200);
  for (const p of ["/server.js", "/package.json", "/data/ballpark.db", "/.git/config", "/js/../server.js", "/js/%2e%2e/server.js"]) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
  assert.equal((await fetch(base + "/%E0%A4%A")).status, 400);
});

test("records a guess and returns crowd stats", async () => {
  const res = await post("/api/guess", { day: TODAY, q: 0, guess: answers[0] * 10, player: "player-aaaa" });
  assert.equal(res.status, 200);
  const st = await res.json();
  assert.equal(st.count, 1);
  assert.equal(st.bins.length, 21);
  assert.equal(st.bins[20], 1); // 10x too high lands in the last bin
  assert.ok(Math.abs(st.offset - 1) < 1e-9);
  assert.equal(st.closerThan, null); // nobody else yet
});

test("first guess wins and closerThan compares against other players", async () => {
  await post("/api/guess", { day: TODAY, q: 0, guess: answers[0], player: "player-aaaa" }); // ignored
  const st = await (await post("/api/guess", { day: TODAY, q: 0, guess: answers[0] * 2, player: "player-bbbb" })).json();
  assert.equal(st.count, 2);
  assert.equal(st.closerThan, 100); // 2x beats the other player's 10x
  const again = await (await fetch(`${base}/api/question?day=${TODAY}&q=0&player=player-aaaa`)).json();
  assert.ok(Math.abs(again.offset - 1) < 1e-9, "original guess kept");
  assert.equal(again.closerThan, 0);
});

test("day endpoint syncs guesses and ranks finished players", async () => {
  const a = await (await post("/api/day", { day: TODAY, player: "player-aaaa", guesses: [answers[0] * 10, answers[1], answers[2]] })).json();
  assert.equal(a.day.count, 1);
  assert.equal(a.day.top, 100);
  const b = await (await post("/api/day", { day: TODAY, player: "player-bbbb", guesses: [answers[0] * 2, answers[1], answers[2]] })).json();
  assert.equal(b.day.count, 2);
  assert.equal(b.day.top, 50);
  assert.ok(Math.abs(b.day.score - Math.pow(10, Math.log10(2) / 3)) < 1e-9);
  assert.equal(b.questions.length, 3);
});

test("rejects bad input", async () => {
  const bad = [
    { day: TODAY + 1, q: 0, guess: 1, player: "player-cccc" },
    { day: 0, q: 0, guess: 1, player: "player-cccc" },
    { day: TODAY, q: 3, guess: 1, player: "player-cccc" },
    { day: TODAY, q: 0, guess: -5, player: "player-cccc" },
    { day: TODAY, q: 0, guess: "abc", player: "player-cccc" },
    { day: TODAY, q: 0, guess: 1, player: "x" },
    { day: TODAY, q: 0, guess: 1, player: "<script>alert(1)</script>" },
  ];
  for (const body of bad) assert.equal((await post("/api/guess", body)).status, 400, JSON.stringify(body));
  assert.equal((await post("/api/guess", "{not json")).status, 400);
  assert.equal((await post("/api/guess", "{}", { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post("/api/guess", JSON.stringify({ pad: "x".repeat(5000) }))).status, 413);
  assert.equal((await fetch(base + "/api/nope")).status, 404);
});

/* ---------------- Accounts ---------------- */
const cookieFrom = (res) => (res.headers.get("set-cookie") || "").split(";")[0];
const postAs = (cookie, path, body) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
const meAs = async (cookie) => (await fetch(base + "/api/me", { headers: { Cookie: cookie } })).json();

let aliceCookie;

test("sign up keeps this browser's earlier guesses and starts a session", async () => {
  await post("/api/guess", { day: TODAY, q: 0, guess: answers[0], player: "anon-alice-1" });
  const res = await post("/api/signup", { username: "Alice_1", password: "correct horse", player: "anon-alice-1" });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get("set-cookie");
  assert.match(setCookie, /bp_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+/);
  aliceCookie = cookieFrom(res);
  const me = await res.json();
  assert.equal(me.user.username, "Alice_1");
  assert.equal(me.player, "anon-alice-1");
  assert.equal(me.history.length, 1);
  assert.equal(me.history[0].guesses[0], answers[0]);
  assert.equal(me.stats.played, 0); // only 1 of 3 answered
});

test("usernames are unique (case-insensitive) and validated", async () => {
  assert.equal((await post("/api/signup", { username: "alice_1", password: "whatever123" })).status, 409);
  assert.equal((await post("/api/signup", { username: "a", password: "whatever123" })).status, 400);
  assert.equal((await post("/api/signup", { username: "bad name!", password: "whatever123" })).status, 400);
  assert.equal((await post("/api/signup", { username: "shortpw", password: "1234" })).status, 400);
});

test("signed-in guesses go to the account, whatever player id the browser sends", async () => {
  const res = await postAs(aliceCookie, "/api/day", { day: TODAY, guesses: [answers[0], answers[1] * 2, answers[2]], player: "someone-else-1" });
  assert.equal(res.status, 200);
  const me = await meAs(aliceCookie);
  assert.equal(me.stats.played, 1);
  assert.equal(me.stats.streak, 1);
  assert.ok(Math.abs(me.stats.best - Math.pow(10, Math.log10(2) / 3)) < 1e-9);
  // Nothing was recorded under the id the browser claimed.
  const other = await (await fetch(`${base}/api/question?day=${TODAY}&q=1&player=someone-else-1`)).json();
  assert.equal(other.offset, undefined);
});

test("an account's player id can't be used without signing in", async () => {
  const res = await post("/api/guess", { day: TODAY, q: 2, guess: 5, player: "anon-alice-1" });
  assert.equal(res.status, 401);
});

test("sign out ends the session", async () => {
  const res = await postAs(aliceCookie, "/api/logout", {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
  assert.deepEqual(await meAs(aliceCookie), { user: null });
});

test("sign in checks the password and folds in guesses made while signed out", async () => {
  assert.equal((await post("/api/login", { username: "alice_1", password: "wrong password" })).status, 401);
  assert.equal((await post("/api/login", { username: "nobody_here", password: "whatever123" })).status, 401);
  // A new device plays question 0 of today anonymously (already answered on the account, so the account's answer wins)...
  await post("/api/guess", { day: TODAY, q: 0, guess: answers[0] * 1000, player: "anon-device-2" });
  const res = await post("/api/login", { username: "ALICE_1", password: "correct horse", player: "anon-device-2" });
  assert.equal(res.status, 200);
  aliceCookie = cookieFrom(res);
  const me = await res.json();
  assert.equal(me.user.username, "Alice_1");
  assert.equal(me.history.find((h) => h.day === TODAY).guesses[0], answers[0]);
  assert.equal(me.stats.played, 1);
  // ...and the anonymous copy is gone.
  const st = await (await fetch(`${base}/api/question?day=${TODAY}&q=0&player=anon-device-2`)).json();
  assert.equal(st.offset, undefined);
});

test("sessions renew on visits (rolling 90 days)", async () => {
  // A fresh session isn't rewritten on every request...
  const quiet = await fetch(base + "/api/me", { headers: { Cookie: aliceCookie } });
  assert.equal(quiet.headers.get("set-cookie"), null);
  // ...but one that's been running a while is pushed back out to 90 days.
  const { createHash } = require("node:crypto");
  const token = aliceCookie.split("=")[1];
  const hash = createHash("sha256").update(token).digest("hex");
  const in80Days = Date.now() + 80 * 864e5;
  await server.__db.run("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", [in80Days, hash]);
  const renewed = await fetch(base + "/api/me", { headers: { Cookie: aliceCookie } });
  assert.match(renewed.headers.get("set-cookie"), /Max-Age=7776000/);
  const [row] = await server.__db.all("SELECT expires_at FROM sessions WHERE token_hash = ?", [hash]);
  assert.ok(row.expires_at > Date.now() + 89 * 864e5);
  assert.equal((await renewed.json()).user.username, "Alice_1");
});

test("auth endpoints are rate limited", async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await post("/api/login", { username: "alice_1", password: "nope-nope" });
  assert.equal(last.status, 429);
});
