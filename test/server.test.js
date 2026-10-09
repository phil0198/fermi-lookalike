"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../server.js");
const Puzzle = require("../js/puzzle.js");

let server, base;
const TODAY = Puzzle.today();
const answers = Puzzle.puzzleFor(TODAY).map((p) => p.a);

before(async () => {
  server = createServer({ dbPath: ":memory:" });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

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
