/*
 * Daily puzzle selection, shared by the browser (window.BallparkPuzzle)
 * and the server (require("./js/puzzle.js")) so both agree on which
 * questions belong to which day.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./questions.js"));
  } else {
    root.BallparkPuzzle = factory({ categories: root.BALLPARK_CATEGORIES, questions: root.BALLPARK_QUESTIONS });
  }
})(typeof self !== "undefined" ? self : this, function (bank) {
  "use strict";

  const LAUNCH = "2026-01-01"; // Puzzle No. 001
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

  function puzzleFor(day) {
    const cats = shuffle(CAT_KEYS, rng(day * 7919 + 1)).slice(0, PER_DAY);
    return cats.map((cat) => {
      const list = BANK[cat];
      // Fixed shuffled order per category, walked one step per day, so repeats are rare.
      const order = shuffle(list.map((_, i) => i), rng(cat.length * 104729 + cat.charCodeAt(1)));
      return { cat, ...list[order[(day + cat.charCodeAt(0)) % list.length]] };
    });
  }

  return { LAUNCH, TZ, PER_DAY, CATS, etDate, dayIndex, dateOf, today, rng, shuffle, puzzleFor };
});
