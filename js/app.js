(() => {
  "use strict";

  const CATS = window.BALLPARK_CATEGORIES;
  const BANK = window.BALLPARK_QUESTIONS;
  const CAT_KEYS = Object.keys(CATS);
  const LAUNCH = "2026-01-01"; // Puzzle No. 001
  const TZ = "America/New_York";
  const STORE_KEY = "ballpark:v2";
  const PER_DAY = 3;
  const CROWD = 1500; // simulated players per question (no backend)

  /* ---------------- Storage ---------------- */
  const store = {
    load() {
      try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { games: {} }; }
      catch { return { games: {} }; }
    },
    save(d) { try { localStorage.setItem(STORE_KEY, JSON.stringify(d)); } catch { /* private mode */ } },
  };
  const db = store.load();

  /* ---------------- Dates (Eastern Time) ---------------- */
  const etDate = (d = new Date()) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const dayIndex = (s) => Math.round((Date.parse(s + "T00:00:00Z") - Date.parse(LAUNCH + "T00:00:00Z")) / 864e5) + 1;
  const dateOf = (n) => new Date(Date.parse(LAUNCH + "T00:00:00Z") + (n - 1) * 864e5).toISOString().slice(0, 10);
  const prettyDate = (s) => new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const pad3 = (n) => String(n).padStart(3, "0");
  const TODAY = Math.max(1, dayIndex(etDate()));

  /* ---------------- Seeded randomness ---------------- */
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
  function gauss(rand) {
    return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  }

  /* ---------------- Daily puzzle ---------------- */
  function puzzleFor(day) {
    const cats = shuffle(CAT_KEYS, rng(day * 7919 + 1)).slice(0, PER_DAY);
    return cats.map((cat) => {
      const list = BANK[cat];
      // Fixed shuffled order per category, walked one step per day, so repeats are rare.
      const order = shuffle(list.map((_, i) => i), rng(cat.length * 104729 + cat.charCodeAt(1)));
      return { cat, ...list[order[(day + cat.charCodeAt(0)) % list.length]] };
    });
  }

  /* Simulated crowd: log10(guess/answer) offsets for each question. */
  function crowdFor(day, i) {
    const rand = rng(day * 1009 + i * 31 + 7);
    const bias = (rand() - 0.6) * 0.7; // crowds tend to underestimate
    const spread = 0.45 + rand() * 0.25;
    return Array.from({ length: CROWD }, () => bias + gauss(rand) * spread);
  }
  function crowdScores(day) {
    const per = [0, 1, 2].map((i) => crowdFor(day, i));
    return per[0].map((_, k) => Math.pow(10, (Math.abs(per[0][k]) + Math.abs(per[1][k]) + Math.abs(per[2][k])) / 3));
  }

  /* ---------------- Scoring ---------------- */
  const ratio = (g, a) => Math.max(g / a, a / g); // ≥ 1, lower is better
  const dayScore = (guesses, pz) => Math.pow(10, guesses.reduce((s, g, i) => s + Math.abs(Math.log10(g / pz[i].a)), 0) / guesses.length);
  const fmtX = (r) => (r >= 1000 ? Math.round(r).toLocaleString("en-US") : Number(r.toPrecision(3)).toFixed(r >= 100 ? 0 : r >= 10 ? 1 : 2)) + "×";

  /* ---------------- Numbers ---------------- */
  function fmtNum(n) {
    if (n >= 1e12) return trim(n / 1e12) + " trillion";
    if (n >= 1e9) return trim(n / 1e9) + " billion";
    if (n >= 1e7) return trim(n / 1e6) + " million";
    if (n >= 100) return Math.round(n).toLocaleString("en-US");
    return trim(n);
  }
  function trim(n) { return Number(n.toPrecision(3)).toLocaleString("en-US", { maximumFractionDigits: 2 }); }
  function compact(n) {
    const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
    for (const [v, s] of units) if (n >= v) return trim(n / v) + s;
    return trim(n);
  }

  // Safe arithmetic evaluator: numbers (with k/m/b/t suffixes), + - * / ^ and parentheses.
  const SUFFIX = { k: 1e3, thousand: 1e3, m: 1e6, mil: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12 };
  function evaluate(src) {
    const s = String(src).toLowerCase().replace(/[,\s_]/g, "").replace(/[×x]/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
    let i = 0;
    const peek = () => s[i];
    function num() {
      const m = s.slice(i).match(/^(\d*\.?\d+(?:e[+-]?\d+)?)([a-z]*)/);
      if (!m) throw 0;
      i += m[0].length;
      if (m[2] && !(m[2] in SUFFIX)) throw 0;
      return parseFloat(m[1]) * (m[2] ? SUFFIX[m[2]] : 1);
    }
    function atom() {
      if (peek() === "(") { i++; const v = expr(); if (peek() !== ")") throw 0; i++; return v; }
      if (peek() === "-") { i++; return -atom(); }
      return num();
    }
    function power() { const b = atom(); if (peek() === "^") { i++; return Math.pow(b, power()); } return b; }
    function term() {
      let v = power();
      while (peek() === "*" || peek() === "/") { const op = s[i++]; const r = power(); v = op === "*" ? v * r : v / r; }
      return v;
    }
    function expr() {
      let v = term();
      while (peek() === "+" || peek() === "-") { const op = s[i++]; const r = term(); v = op === "+" ? v + r : v - r; }
      return v;
    }
    try {
      if (!s) return NaN;
      const v = expr();
      return i === s.length ? v : NaN;
    } catch { return NaN; }
  }
  const valid = (v) => Number.isFinite(v) && v > 0;

  /* ---------------- DOM helpers ---------------- */
  const $ = (q) => document.querySelector(q);
  function h(tag, attrs = {}, ...kids) {
    const n = tag === "svg" ? document.createElementNS("http://www.w3.org/2000/svg", "svg") : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") n.setAttribute("class", v);
      else if (k === "style") n.style.cssText = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : String(kid));
    return n;
  }

  const ICONS = {
    drop: '<path d="M12 3.5c3.2 4 5.5 7.2 5.5 10a5.5 5.5 0 0 1-11 0c0-2.8 2.3-6 5.5-10Z"/>',
    building: '<path d="M4 20.5h16M6 20.5V8l6-3.5v16M12 20.5V9.5l6 2v9"/><path d="M8.5 9.5v.01M8.5 12.5v.01M8.5 15.5v.01M15 13.5v.01M15 16.5v.01"/>',
    paw: '<circle cx="7" cy="10" r="1.8"/><circle cx="10.3" cy="6.3" r="1.8"/><circle cx="13.8" cy="6.3" r="1.8"/><circle cx="17" cy="10" r="1.8"/><path d="M12 11.5c-2.6 0-5 3.4-5 5.6 0 1.6 1.3 2.4 2.7 2.4 1 0 1.5-.5 2.3-.5s1.3.5 2.3.5c1.4 0 2.7-.8 2.7-2.4 0-2.2-2.4-5.6-5-5.6Z"/>',
    planet: '<circle cx="12" cy="12" r="5.5"/><path d="M5.2 15.6C2.6 17.5 1.6 19.2 2.3 20c1.1 1.3 6.3-1 11.6-5.1S23 6.4 21.8 5c-.6-.8-2.4-.3-4.8 1.1"/>',
    cup: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5V9Z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5c-.6.8-.6 1.7 0 2.5M11 3.5c-.6.8-.6 1.7 0 2.5"/>',
    ball: '<circle cx="12" cy="12" r="8.5"/><path d="M3.8 9.5c3 .5 5.8 2.6 7 6M20.2 14.5c-3-.5-5.8-2.6-7-6M9.2 3.9c.4 3 2.4 5.7 5.6 7M14.8 20.1c-.4-3-2.4-5.7-5.6-7"/>',
    chip: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.3 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.3-3.5-8.5S9.6 5.9 12 3.5Z"/>',
  };
  const icon = (name) => h("svg", { class: "ico", viewBox: "0 0 24 24", "aria-hidden": "true", html: ICONS[name] });

  /* ---------------- State ---------------- */
  const qs = new URLSearchParams(location.search);
  let day = parseInt(qs.get("day"), 10);
  if (!(day >= 1 && day <= TODAY)) day = TODAY;
  const puzzle = puzzleFor(day);
  const game = db.games[day] || { guesses: [] };
  // view: {mode: "question"|"reveal"|"summary", i}
  let view = game.guesses.length >= PER_DAY ? { mode: "summary" } : { mode: "question", i: game.guesses.length };

  const persist = () => { db.games[day] = game; store.save(db); };

  /* ---------------- Header ---------------- */
  function renderHead() {
    $("#card").dataset.mode = view.mode;
    $("#puzzleNo").textContent = `No. ${pad3(day)}`;
    const steps = $("#steps");
    steps.replaceChildren(...puzzle.map((p, i) => {
      const active = view.mode === "summary" || i <= (view.i ?? 0) || game.guesses[i] != null;
      return h("li", { class: "step" + (active ? " on" : ""), title: CATS[p.cat].label },
        h("span", { class: "step-q" }, `Q${i + 1}`), icon(CATS[p.cat].icon));
    }));
  }

  /* ---------------- Question view ---------------- */
  function renderQuestion(i) {
    const p = puzzle[i];
    const input = h("input", {
      class: "guess", id: "guess", type: "text", inputmode: "decimal", autocomplete: "off",
      spellcheck: "false", placeholder: "your guess", "aria-label": `Your guess in ${p.unit}`,
    });
    const hint = h("p", { class: "hint", "aria-live": "polite" }, " ");
    const lock = h("button", { class: "pill pill-outline", type: "submit", disabled: true },
      "Lock it in", h("span", { class: "kbd", "aria-hidden": "true" }, "↵"));

    const sync = () => {
      const v = evaluate(input.value);
      lock.disabled = !valid(v);
      if (!input.value.trim()) hint.textContent = " ";
      else if (valid(v)) hint.textContent = /[^\d.,\s]/.test(input.value) ? `= ${fmtNum(v)} ${p.unit}` : " ";
      else hint.textContent = "Enter a positive number, e.g. 2.5k or 365*24";
      hint.classList.toggle("err", !!input.value.trim() && !valid(v));
    };
    input.addEventListener("input", sync);

    const calcBtn = h("button", { class: "round-btn", type: "button", "aria-label": "Open calculator", onclick: () => openCalc(input, sync) },
      h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", html: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><rect x="8" y="6" width="8" height="3.5" rx=".6"/><path d="M8.5 13h.01M12 13h.01M15.5 13h.01M8.5 16.5h.01M12 16.5h.01M15.5 16.5h.01"/>' }));

    const form = h("form", {
      class: "guess-form",
      onsubmit: (e) => {
        e.preventDefault();
        const v = evaluate(input.value);
        if (!valid(v)) return;
        game.guesses[i] = v;
        persist();
        go({ mode: "reveal", i });
      },
    },
      h("label", { class: "guess-wrap" }, input, h("span", { class: "unit" }, p.unit)),
      hint,
      h("div", { class: "row-between" }, calcBtn, lock)
    );

    $("#body").replaceChildren(h("h1", { class: "question" }, p.q), form);
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }

  /* ---------------- Calculator ---------------- */
  function openCalc(target, after) {
    const display = h("input", { class: "calc-display", type: "text", inputmode: "none", value: target.value, "aria-label": "Calculator expression" });
    const result = h("div", { class: "calc-result" }, " ");
    const refresh = () => {
      const v = evaluate(display.value);
      result.textContent = valid(v) ? "= " + fmtNum(v) : display.value ? "…" : " ";
    };
    const insert = (t) => { display.value += t; refresh(); };
    const keys = ["(", ")", "⌫", "C", "7", "8", "9", "÷", "4", "5", "6", "×", "1", "2", "3", "−", "0", ".", "k", "+", "m", "b", "^", "="];
    const pad = h("div", { class: "calc-keys" }, keys.map((k) =>
      h("button", {
        type: "button", class: "calc-key" + ("÷×−+^=".includes(k) ? " op" : "") + (k === "=" ? " eq" : ""),
        onclick: () => {
          if (k === "C") { display.value = ""; refresh(); }
          else if (k === "⌫") { display.value = display.value.slice(0, -1); refresh(); }
          else if (k === "=") use();
          else insert(k);
        },
      }, k)));
    const overlay = h("div", { class: "calc", role: "dialog", "aria-label": "Calculator" },
      h("div", { class: "calc-top" },
        h("span", { class: "eyebrow" }, "Scratchpad"),
        h("button", { class: "icon-btn", type: "button", "aria-label": "Close calculator", onclick: () => close() },
          h("svg", { viewBox: "0 0 24 24", width: 20, height: 20, "aria-hidden": "true", html: '<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' }))),
      display, result, pad,
      h("button", { class: "pill pill-solid calc-use", type: "button", onclick: () => use() }, "Use as guess"));
    function use() {
      const v = evaluate(display.value);
      if (!valid(v)) { overlay.classList.add("shake"); setTimeout(() => overlay.classList.remove("shake"), 400); return; }
      target.value = String(+v.toPrecision(6));
      close();
      after();
      target.focus();
    }
    function close() { overlay.remove(); document.removeEventListener("keydown", onKey, true); }
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
      else if (e.key === "Enter") { e.preventDefault(); use(); }
    }
    display.addEventListener("input", refresh);
    document.addEventListener("keydown", onKey, true);
    $("#card").append(overlay);
    refresh();
    display.focus();
  }

  /* ---------------- Histograms ---------------- */
  // values: log10 offsets; [lo, hi]: range; returns bar heights normalized 0..1
  function bins(values, lo, hi, n) {
    const counts = new Array(n).fill(0);
    for (const v of values) {
      const k = Math.floor(((v - lo) / (hi - lo)) * n);
      if (k >= 0 && k < n) counts[k]++;
    }
    const max = Math.max(1, ...counts);
    return counts.map((c) => c / max);
  }
  const pct = (v, lo, hi) => Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100));

  function histogram({ values, lo, hi, n, you, mark, labels, cls }) {
    const heights = bins(values, lo, hi, n);
    return h("div", { class: "hist " + (cls || "") },
      h("div", { class: "hist-plot" },
        heights.map((v) => h("span", { class: "bar", style: `--h:${Math.max(0.015, v)}` })),
        mark != null ? h("span", { class: "hist-mark", style: `left:${pct(mark, lo, hi)}%` }) : null,
        h("span", { class: "hist-you" + (pct(you, lo, hi) > 85 ? " edge-r" : pct(you, lo, hi) < 15 ? " edge-l" : ""), style: `left:${pct(you, lo, hi)}%` }, h("b", {}, "You"))
      ),
      h("div", { class: "hist-axis" }, labels.map(([v, text, sub]) =>
        h("span", { style: `left:${pct(v, lo, hi)}%` }, text, sub ? h("small", {}, sub) : null)))
    );
  }

  /* ---------------- Reveal view ---------------- */
  function renderReveal(i) {
    const p = puzzle[i];
    const g = game.guesses[i];
    const off = Math.log10(g / p.a);
    const r = ratio(g, p.a);
    const crowd = crowdFor(day, i);
    const beat = Math.round((crowd.filter((c) => Math.abs(c) > Math.abs(off)).length / crowd.length) * 100);
    const spot = r < 1.005;
    const last = i === PER_DAY - 1;

    const napkin = h("details", { class: "napkin" },
      h("summary", {}, h("span", {}, "Napkin math"), h("svg", { class: "chev", viewBox: "0 0 24 24", "aria-hidden": "true", html: '<path d="m6 15 6-6 6 6"/>' })),
      h("p", {}, p.napkin));

    const next = h("button", { class: "pill pill-white", type: "button", onclick: () => go(last ? { mode: "summary" } : { mode: "question", i: i + 1 }) },
      last ? "Results" : `Question ${i + 2}`, h("span", { "aria-hidden": "true" }, " →"));

    $("#body").replaceChildren(
      h("p", { class: "question-mini" }, p.q),
      h("div", { class: "duo" },
        h("div", { class: "box box-dim" }, h("p", { class: "eyebrow" }, "You guessed"), h("p", { class: "big-num" }, fmtNum(g)), h("p", { class: "box-unit" }, p.unit)),
        h("div", { class: "box box-answer" }, h("p", { class: "eyebrow" }, "Answer"), h("p", { class: "big-num" }, fmtNum(p.a)), h("p", { class: "box-unit" }, p.unit))
      ),
      h("div", { class: "split" },
        h("div", { class: "landed" },
          h("p", { class: "eyebrow" }, "You landed"),
          h("p", { class: "landed-x" }, spot ? "Spot" : fmtX(r)),
          h("p", { class: "landed-dir" }, spot ? "On!" : off > 0 ? "Too High" : "Too Low"),
          h("p", { class: "landed-sub" }, `closer than ${beat}% of players`)
        ),
        h("div", { class: "everyone" },
          h("p", { class: "eyebrow" }, "How everyone guessed"),
          histogram({
            values: crowd, lo: -1, hi: 1, n: 21, you: off, mark: 0,
            labels: [[-1, compact(p.a / 10)], [0, compact(p.a), "Answer"], [1, compact(p.a * 10)]],
          })
        )
      ),
      h("div", { class: "row-between foot" }, napkin, next)
    );
    next.focus({ preventScroll: true });
  }

  /* ---------------- Summary view ---------------- */
  function renderSummary() {
    const score = dayScore(game.guesses, puzzle);
    const crowd = crowdScores(day);
    const top = Math.max(1, Math.ceil((crowd.filter((c) => c <= score).length / crowd.length) * 100));
    const logCrowd = crowd.map((c) => Math.log10(c));

    const rows = puzzle.map((p, i) => {
      const g = game.guesses[i];
      return h("li", { class: "sum-row" },
        h("span", { class: "sum-q" }, p.q),
        h("span", { class: "sum-x" }, h("i", {}, g >= p.a ? ">" : "<"), fmtX(ratio(g, p.a))));
    });

    $("#body").replaceChildren(
      h("div", { class: "summary" },
        h("div", { class: "sum-left" },
          h("p", { class: "label" }, "Score"),
          h("p", { class: "score" }, fmtX(score)),
          h("span", { class: "tag" }, `Top ${top}%`),
          h("p", { class: "label" }, "How everyone did"),
          histogram({
            values: logCrowd, lo: 0, hi: 3, n: 21, you: Math.log10(score), cls: "dark",
            labels: [[0, "1×"], [1, "10×"], [2, "100×"], [3, "1,000×"]],
          }),
          h("div", { class: "actions" },
            h("button", { class: "pill pill-dark", type: "button", onclick: shareCard }, "Share card"),
            h("button", { class: "pill pill-outline-dark", type: "button", onclick: copyText }, "Copy text"))
        ),
        h("div", { class: "sum-right" },
          h("p", { class: "label" }, "Questions"),
          h("ol", { class: "sum-list" }, rows),
          day !== TODAY ? h("a", { class: "pill pill-outline-dark small", href: "./" }, "Play today's puzzle →") : null
        )
      )
    );
  }

  /* ---------------- Sharing ---------------- */
  function shareLines() {
    return puzzle.map((p, i) => {
      const g = game.guesses[i];
      const r = ratio(g, p.a);
      const sq = r <= 1.25 ? "🟩" : r <= 2 ? "🟨" : r <= 5 ? "🟧" : "🟥";
      return `Q${i + 1} ${sq} ${g >= p.a ? ">" : "<"}${fmtX(r)}`;
    });
  }
  function shareTextBody() {
    return `Ballpark No. ${pad3(day)}: ${fmtX(dayScore(game.guesses, puzzle))}\n${shareLines().join("\n")}\n${location.origin}${location.pathname}`;
  }
  async function copyText() {
    try { await navigator.clipboard.writeText(shareTextBody()); toast("Copied to clipboard"); }
    catch { toast("Couldn't access clipboard"); }
  }
  async function shareCard() {
    const c = document.createElement("canvas");
    c.width = 1080; c.height = 1080;
    const x = c.getContext("2d");
    const font = (w, s) => `${w} ${s}px "Inter Tight", "Helvetica Neue", Arial, sans-serif`;
    x.fillStyle = "#efd45b"; x.fillRect(0, 0, 1080, 1080);
    x.fillStyle = "#111";
    x.font = font(800, 48); x.fillText("Ballpark", 90, 140);
    x.textAlign = "right"; x.fillText(`No. ${pad3(day)}`, 990, 140); x.textAlign = "left";
    x.font = font(700, 36); x.globalAlpha = 0.7; x.fillText("SCORE", 90, 300); x.globalAlpha = 1;
    x.font = font(900, 260); x.fillText(fmtX(dayScore(game.guesses, puzzle)), 80, 540);
    x.font = font(700, 50);
    puzzle.forEach((p, i) => {
      const g = game.guesses[i];
      const y = 700 + i * 100;
      x.fillText(`Q${i + 1}  ${CATS[p.cat].label}`, 90, y);
      x.textAlign = "right"; x.fillText(`${g >= p.a ? ">" : "<"} ${fmtX(ratio(g, p.a))}`, 990, y); x.textAlign = "left";
      x.fillRect(90, y + 32, 900, 3);
    });
    const blob = await new Promise((res) => c.toBlob(res, "image/png"));
    const file = new File([blob], `ballpark-${pad3(day)}.png`, { type: "image/png" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: shareTextBody() });
        return;
      }
    } catch (e) { if (e && e.name === "AbortError") return; }
    const a = h("a", { href: URL.createObjectURL(blob), download: file.name });
    document.body.append(a); a.click(); a.remove();
    toast("Saved share card");
  }

  let toastT;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2000);
  }

  /* ---------------- Navigation ---------------- */
  function go(next) {
    view = next;
    const body = $("#body");
    body.classList.remove("enter");
    void body.offsetWidth; // restart animation
    body.classList.add("enter");
    render();
  }
  function render() {
    renderHead();
    if (view.mode === "question") renderQuestion(view.i);
    else if (view.mode === "reveal") renderReveal(view.i);
    else renderSummary();
  }

  /* ---------------- Drawer / archive ---------------- */
  function renderArchive() {
    const list = $("#archiveList");
    list.replaceChildren();
    for (let n = TODAY; n >= 1; n--) {
      const g = db.games[n];
      const done = g && g.guesses.length >= PER_DAY;
      const status = done ? fmtX(dayScore(g.guesses, puzzleFor(n))) : g && g.guesses.length ? "In progress" : "—";
      list.append(h("li", {},
        h("a", { href: n === TODAY ? "./" : `?day=${n}`, class: n === day ? "active" : null },
          h("span", { class: "arch-no" }, `No. ${pad3(n)}`),
          h("span", { class: "arch-date" }, n === TODAY ? "Today" : prettyDate(dateOf(n))),
          h("span", { class: "arch-score" + (done ? "" : " muted") }, status))));
    }
  }
  function openDrawer() {
    renderArchive();
    const d = $("#drawer");
    d.inert = false; d.setAttribute("aria-hidden", "false"); d.classList.add("open");
    $("#menuBtn").setAttribute("aria-expanded", "true");
    $("#scrim").hidden = false;
    requestAnimationFrame(() => $("#scrim").classList.add("show"));
    $("#drawerClose").focus();
  }
  function closeDrawer() {
    const d = $("#drawer");
    if (!d.classList.contains("open")) return;
    d.classList.remove("open"); d.setAttribute("aria-hidden", "true"); d.inert = true;
    $("#menuBtn").setAttribute("aria-expanded", "false");
    $("#scrim").classList.remove("show");
    setTimeout(() => ($("#scrim").hidden = true), 250);
  }

  /* ---------------- Stats ---------------- */
  function renderStats() {
    const done = Object.keys(db.games).map(Number).filter((n) => db.games[n].guesses.length >= PER_DAY).sort((a, b) => a - b);
    const scores = done.map((n) => dayScore(db.games[n].guesses, puzzleFor(n)));
    let maxRun = 0, run = 0;
    done.forEach((n, k) => { run = k && n === done[k - 1] + 1 ? run + 1 : 1; maxRun = Math.max(maxRun, run); });
    const set = new Set(done);
    let cur = 0;
    for (let n = set.has(TODAY) ? TODAY : TODAY - 1; set.has(n); n--) cur++;
    const avg = scores.length ? Math.pow(10, scores.reduce((s, v) => s + Math.log10(v), 0) / scores.length) : null;
    const tile = (v, l) => h("div", { class: "stat" }, h("b", {}, v), h("span", {}, l));
    $("#statGrid").replaceChildren(
      tile(done.length, "Played"),
      tile(avg ? fmtX(avg) : "—", "Average"),
      tile(scores.length ? fmtX(Math.min(...scores)) : "—", "Best"),
      tile(cur, "Streak"),
      tile(maxRun, "Max streak"));
  }

  /* ---------------- Countdown ---------------- */
  function tickCountdown() {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date()).reduce((o, x) => ((o[x.type] = x.value), o), {});
    const left = 86400 - ((+p.hour % 24) * 3600 + +p.minute * 60 + +p.second);
    const hh = String(Math.floor(left / 3600)).padStart(2, "0");
    const mm = String(Math.floor((left % 3600) / 60)).padStart(2, "0");
    const ss = String(left % 60).padStart(2, "0");
    $("#countdown").textContent = dayIndex(etDate()) > TODAY ? "New puzzle ready. Refresh!" : `Next puzzle in ${hh}:${mm}:${ss}`;
  }

  /* ---------------- Wire up ---------------- */
  $("#menuBtn").addEventListener("click", openDrawer);
  $("#archiveBtn").addEventListener("click", openDrawer);
  $("#drawerClose").addEventListener("click", closeDrawer);
  $("#scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  $("#helpBtn").addEventListener("click", () => $("#helpModal").showModal());
  $("#statsBtn").addEventListener("click", () => { renderStats(); $("#statsModal").showModal(); });
  for (const d of document.querySelectorAll("dialog")) d.addEventListener("click", (e) => { if (e.target === d) d.close(); });

  render();
  tickCountdown();
  setInterval(tickCountdown, 1000);

  if (!db.seenHelp) {
    db.seenHelp = true;
    store.save(db);
    $("#helpModal").showModal();
  }
})();
