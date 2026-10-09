/*
 * Daily puzzle selection, shared by the browser (window.BallparkPuzzle)
 * and the server (require("./js/puzzle.js")) so both agree on which
 * questions belong to which day.
 *
 * Every day draws 3 different categories. Categories are dealt from
 * shuffled decks so they're used evenly, and within a category each
 * question is used once before any of them repeats. With 240 questions
 * that's about 80 days before the first repeat.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./questions.js"));
  } else {
    root.BallparkPuzzle = factory({ categories: root.BALLPARK_CATEGORIES, questions: root.BALLPARK_QUESTIONS });
  }
})(typeof self !== "undefined" ? self : this, function (bank) {
  "use strict";

  const LAUNCH = "2026-10-08"; // Puzzle No. 001
  const TZ = "America/New_York";
  const PER_DAY = 3;
  const CATS = bank.categories;
  const BANK = bank.questions;
  const CAT_KEYS = Object.keys(CATS);

  const etDate = (d = new Date()) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const dayIndex = (s) => Math.round((Date.parse(s + "T00:00:00Z") - Date.parse(LAUNCH + "T00:00:00Z")) / 864e5) + 1;
  const dateOf = (n) => new Date(Date.parse(LAUNCH + "T00:00:00Z") + (n - 1) * 864e5).toISOString().slice(0, 10);
  const today = () => Math.max(1, dayIndex(etDate()));

  function rng(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rand) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  // Question order for one pass ("lap") through a category. Each lap is a
  // fresh shuffle; if it would start with the question the previous lap
  // ended on, the first two are swapped so it never repeats back to back.
  const lapCache = new Map();
  function lapOrder(cat, lap) {
    const key = cat + ":" + lap;
    if (lapCache.has(key)) return lapCache.get(key);
    const n = BANK[cat].length;
    const order = shuffle([...Array(n).keys()], rng(hash(cat) + lap * 7919));
    if (lap > 0 && n > 1 && order[0] === lapOrder(cat, lap - 1)[n - 1]) [order[0], order[1]] = [order[1], order[0]];
    lapCache.set(key, order);
    return order;
  }

  // The schedule is built forward from day 1 and cached.
  const schedule = []; // schedule[day - 1] = [{cat, index}, ...]
  const used = Object.fromEntries(CAT_KEYS.map((c) => [c, 0]));
  let deck = [];
  let deckNo = 0;
  let carry = [];
  function nextCat() {
    if (!deck.length) deck = shuffle(CAT_KEYS, rng(9001 + deckNo++ * 104729));
    return deck.shift();
  }
  function extendTo(day) {
    while (schedule.length < day) {
      const cats = [];
      const skipped = [];
      // Categories bumped from an earlier day (to avoid a duplicate) go first.
      for (const c of carry) (cats.length < PER_DAY && !cats.includes(c) ? cats : skipped).push(c);
      while (cats.length < PER_DAY) {
        const c = nextCat();
        (cats.includes(c) ? skipped : cats).push(c);
      }
      carry = skipped;
      schedule.push(cats.map((cat) => {
        const n = BANK[cat].length;
        const k = used[cat]++;
        return { cat, index: lapOrder(cat, Math.floor(k / n))[k % n] };
      }));
    }
  }

  function puzzleFor(day) {
    extendTo(day);
    return schedule[day - 1].map(({ cat, index }) => ({ cat, ...BANK[cat][index] }));
  }

  return { LAUNCH, TZ, PER_DAY, CATS, etDate, dayIndex, dateOf, today, rng, shuffle, puzzleFor };
});
