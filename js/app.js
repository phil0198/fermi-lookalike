(() => {
  "use strict";

  const Puzzle = window.BallparkPuzzle;
  const { CATS, PER_DAY, TZ, etDate, dayIndex, dateOf, rng, puzzleFor } = Puzzle;
  const STORE_KEY = "ballpark:v3";
  const CROWD = 1500; // simulated players per question, used only when the server is unreachable
  const HIST_BINS = 21;
  const Q_RANGE = [-1, 1]; // answer/10 .. answer*10 (log10 offsets)
  const DAY_RANGE = [0, 3]; // 1x .. 1,000x (log10)

  /* ---------------- Storage ---------------- */
  const store = {
    load() {
      try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { games: {} }; }
      catch { return { games: {} }; }
    },
    save(d) { try { localStorage.setItem(STORE_KEY, JSON.stringify(d)); } catch { /* private mode */ } },
  };
  const db = store.load();
  const newPlayerId = () =>
    crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  if (!db.player) {
    db.player = newPlayerId();
    store.save(db);
  }

  /* ---------------- Dates ---------------- */
  const prettyDate = (s) => new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const pad3 = (n) => String(n).padStart(3, "0");
  const TODAY = Puzzle.today();

  /* ---------------- Server API ---------------- */
  // Resolves to the parsed JSON, or null if the server is unreachable (e.g. static hosting).
  async function api(path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, player: db.player }),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // For account calls: resolves {ok, data} or {ok: false, error} with a message to show.
  async function call(path, { method = "POST", body } = {}) {
    try {
      const res = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      return res.ok ? { ok: true, data } : { ok: false, status: res.status, error: data.error || "Something went wrong. Try again." };
    } catch {
      return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
    }
  }

  function gauss(rand) {
    return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  }

  /* Simulated crowd (offline fallback only): log10(guess/answer) offsets per question. */
  function crowdFor(day, i) {
    const rand = rng(day * 1009 + i * 31 + 7);
    const bias = (rand() - 0.6) * 0.7; // crowds tend to underestimate
    const spread = 0.45 + rand() * 0.25;
    return Array.from({ length: CROWD }, () => bias + gauss(rand) * spread);
  }
  function simQuestion(day, i, off) {
    const crowd = crowdFor(day, i);
    return {
      simulated: true, count: crowd.length, range: Q_RANGE, bins: binCounts(crowd, Q_RANGE),
      closerThan: Math.round((crowd.filter((c) => Math.abs(c) > Math.abs(off)).length / crowd.length) * 100),
    };
  }
  function simDay(day, score) {
    const per = [0, 1, 2].map((i) => crowdFor(day, i));
    const logs = per[0].map((_, k) => (Math.abs(per[0][k]) + Math.abs(per[1][k]) + Math.abs(per[2][k])) / 3);
    const mine = Math.log10(score);
    return {
      simulated: true, count: logs.length, range: DAY_RANGE, bins: binCounts(logs, DAY_RANGE),
      top: Math.max(1, Math.ceil((logs.filter((c) => c <= mine).length / logs.length) * 100)),
    };
  }

  /* ---------------- Scoring ---------------- */
  const ratio = (g, a) => Math.max(g / a, a / g); // ≥ 1, lower is better
  const dayScore = (guesses, pz) => Math.pow(10, guesses.reduce((s, g, i) => s + Math.abs(Math.log10(g / pz[i].a)), 0) / guesses.length);
  const fmtX = (r) => (r >= 1000 ? Math.round(r).toLocaleString("en-US") : Number(r.toPrecision(3)).toFixed(r >= 100 ? 0 : r >= 10 ? 1 : 2)) + "×";

  /* ---------------- Numbers ---------------- */
  const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
  const sup = (e) => String(e).replace(/\d/g, (d) => SUP[d]);
  function sci(n) {
    const e = Math.floor(Math.log10(n));
    return `${trim(n / Math.pow(10, e))} × 10${sup(e)}`;
  }
  function fmtNum(n) {
    if (n >= 1e15) return sci(n);
    if (n >= 1e12) return trim(n / 1e12) + " trillion";
    if (n >= 1e9) return trim(n / 1e9) + " billion";
    if (n >= 1e7) return trim(n / 1e6) + " million";
    if (n >= 100) return Math.round(n).toLocaleString("en-US");
    return trim(n);
  }
  function trim(n) { return Number(n.toPrecision(3)).toLocaleString("en-US", { maximumFractionDigits: 2 }); }
  function compact(n) {
    if (n >= 1e15) return sci(n).replace(/ /g, "");
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
    hourglass: '<path d="M6.5 3.5h11M6.5 20.5h11M7.5 3.5c0 4 4.5 5.5 4.5 8.5s-4.5 4.5-4.5 8.5M16.5 3.5c0 4-4.5 5.5-4.5 8.5s4.5 4.5 4.5 8.5"/><path d="M9.5 18.5h5"/>',
    house: '<path d="M4 11 12 4.5l8 6.5"/><path d="M6.5 9.5v10h11v-10"/><path d="M10 19.5v-5h4v5"/>',
  };
  const icon = (name) => h("svg", { class: "ico", viewBox: "0 0 24 24", "aria-hidden": "true", html: ICONS[name] });

  /* ---------------- State ---------------- */
  const qs = new URLSearchParams(location.search);
  let day = parseInt(qs.get("day"), 10);
  if (!(day >= 1 && day <= TODAY)) day = TODAY;
  const puzzle = puzzleFor(day);
  let game = db.games[day] || { guesses: [] };
  // view: {mode: "question"|"reveal"|"summary", i}
  const viewFor = (g) => (g.guesses.length >= PER_DAY ? { mode: "summary" } : { mode: "question", i: g.guesses.length });
  let view = viewFor(game);
  let account = null; // {user, player, history, stats} when signed in

  // Re-read today's game after an account sign-in/out changed what's stored.
  function reloadGame() {
    game = db.games[day] || { guesses: [] };
    go(viewFor(game));
  }

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
  // Same binning as the server: outliers are clamped into the end bins.
  function binCounts(values, [lo, hi]) {
    const counts = new Array(HIST_BINS).fill(0);
    for (const v of values) counts[Math.min(HIST_BINS - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * HIST_BINS)))]++;
    return counts;
  }
  const pct = (v, lo, hi) => Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100));

  function histogram({ bins, range: [lo, hi], you, mark, labels, cls }) {
    const max = Math.max(1, ...bins);
    const at = pct(you, lo, hi);
    return h("div", { class: "hist " + (cls || "") },
      h("div", { class: "hist-plot" },
        bins.map((c) => h("span", { class: "bar", style: `--h:${Math.max(0.015, c / max)}` })),
        mark != null ? h("span", { class: "hist-mark", style: `left:${pct(mark, lo, hi)}%` }) : null,
        h("span", { class: "hist-you" + (at > 85 ? " edge-r" : at < 15 ? " edge-l" : ""), style: `left:${at}%` }, h("b", {}, "You"))
      ),
      h("div", { class: "hist-axis" }, labels.map(([v, text, sub]) =>
        h("span", { style: `left:${pct(v, lo, hi)}%` }, text, sub ? h("small", {}, sub) : null)))
    );
  }
  const crowdNote = (st) => st.simulated ? "simulated" : `${st.count.toLocaleString("en-US")} ${st.count === 1 ? "player" : "players"}`;
  const skeleton = (cls) => h("div", { class: "hist loading " + (cls || "") }, h("div", { class: "hist-plot" }), h("div", { class: "hist-axis" }));

  /* ---------------- Reveal view ---------------- */
  function renderReveal(i) {
    const p = puzzle[i];
    const g = game.guesses[i];
    const off = Math.log10(g / p.a);
    const r = ratio(g, p.a);
    const spot = r < 1.005;
    const last = i === PER_DAY - 1;

    const landedSub = h("p", { class: "landed-sub" }, "\u00a0");
    const note = h("span", { class: "note" });
    const chart = skeleton();

    api("/api/guess", { day, q: i, guess: g }).then((st) => {
      if (!chart.isConnected) return; // player moved on
      st = st || simQuestion(day, i, off);
      landedSub.textContent = st.closerThan == null ? "first to answer this one!" : `closer than ${st.closerThan}% of players`;
      note.textContent = `· ${crowdNote(st)}`;
      chart.replaceWith(histogram({
        bins: st.bins, range: st.range, you: off, mark: 0,
        labels: [[-1, compact(p.a / 10)], [0, compact(p.a), "Answer"], [1, compact(p.a * 10)]],
      }));
    });

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
          landedSub
        ),
        h("div", { class: "everyone" },
          h("p", { class: "eyebrow" }, "How everyone guessed ", note),
          chart
        )
      ),
      h("div", { class: "row-between foot" }, napkin, next)
    );
    next.focus({ preventScroll: true });
  }

  /* ---------------- Summary view ---------------- */
  function renderSummary() {
    const score = dayScore(game.guesses, puzzle);
    const tag = h("span", { class: "tag" }, "\u00a0");
    const note = h("span", { class: "note" });
    const chart = skeleton("dark");

    // Also re-syncs any guesses that failed to send earlier (the server ignores duplicates).
    api("/api/day", { day, guesses: game.guesses }).then((res) => {
      if (res && account) refreshAccount();
      if (!chart.isConnected) return;
      const st = res ? res.day : simDay(day, score);
      tag.textContent = st.count <= 1 ? "First to finish!" : `Top ${st.top}%`;
      note.textContent = `· ${crowdNote(st)}`;
      chart.replaceWith(histogram({
        bins: st.bins, range: st.range, you: Math.log10(score), cls: "dark",
        labels: [[0, "1×"], [1, "10×"], [2, "100×"], [3, "1,000×"]],
      }));
    });

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
          tag,
          h("p", { class: "label" }, "How everyone did ", note),
          chart,
          h("div", { class: "actions" },
            window.BALLPARK_NO_DOWNLOAD ? null : h("button", { class: "pill pill-dark", type: "button", onclick: shareCard }, "Share card"),
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
  function localStats() {
    const done = Object.keys(db.games).map(Number).filter((n) => n <= TODAY && db.games[n].guesses.length >= PER_DAY).sort((a, b) => a - b);
    const scores = done.map((n) => dayScore(db.games[n].guesses, puzzleFor(n)));
    let maxStreak = 0, run = 0;
    done.forEach((n, k) => { run = k && n === done[k - 1] + 1 ? run + 1 : 1; maxStreak = Math.max(maxStreak, run); });
    const set = new Set(done);
    let streak = 0;
    for (let n = set.has(TODAY) ? TODAY : TODAY - 1; set.has(n); n--) streak++;
    return {
      played: done.length,
      average: scores.length ? Math.pow(10, scores.reduce((s, v) => s + Math.log10(v), 0) / scores.length) : null,
      best: scores.length ? Math.min(...scores) : null,
      streak, maxStreak,
    };
  }
  function statTiles(st) {
    const tile = (v, l) => h("div", { class: "stat" }, h("b", {}, v), h("span", {}, l));
    return [
      tile(st.played, "Played"),
      tile(st.average ? fmtX(st.average) : "—", "Average"),
      tile(st.best ? fmtX(st.best) : "—", "Best"),
      tile(st.streak, "Streak"),
      tile(st.maxStreak, "Max streak"),
    ];
  }
  function renderStats() {
    $("#statGrid").replaceChildren(...statTiles(account ? account.stats : localStats()));
    const note = $("#statsNote");
    if (account) {
      note.replaceChildren(`Saved to your account, ${account.user.username}. They follow you to any device.`);
    } else if (serverUp) {
      note.replaceChildren("These stats live only in this browser. ",
        h("button", { class: "link inline", type: "button", onclick: () => { $("#statsModal").close(); openAccount("signup"); } }, "Create a free account"),
        " to keep them on any device.");
    } else {
      note.replaceChildren("These stats live only in this browser.");
    }
  }

  /* ---------------- Accounts ---------------- */
  let serverUp = false;

  function renderAccountBtn() {
    const btn = $("#accountBtn");
    btn.hidden = !serverUp;
    btn.textContent = account ? account.user.username : "Sign in";
    btn.setAttribute("aria-label", account ? `Account: ${account.user.username}` : "Sign in or create an account");
  }

  // Take the server's copy of a signed-in player's history, and send up anything only this browser has.
  function applyAccount(me) {
    account = me && me.user ? me : null;
    renderAccountBtn();
    if (!account) return;
    db.player = me.player;
    const server = new Map();
    for (const row of me.history) {
      const guesses = [];
      for (const g of row.guesses) { if (g == null) break; guesses.push(g); }
      server.set(row.day, guesses);
    }
    let todayChanged = false;
    for (const [d, guesses] of server) {
      const local = db.games[d]?.guesses || [];
      if (guesses.length > local.length) {
        db.games[d] = { guesses };
        if (d === day) todayChanged = true;
      }
    }
    for (const [d, g] of Object.entries(db.games)) {
      const n = Number(d);
      if (n <= TODAY && g.guesses.length > (server.get(n) || []).length) api("/api/day", { day: n, guesses: g.guesses });
    }
    store.save(db);
    if (todayChanged && view.mode !== "reveal") reloadGame();
  }

  async function refreshAccount() {
    const res = await call("/api/me", { method: "GET" });
    if (res.ok) applyAccount(res.data);
  }

  function openAccount(mode) {
    renderAccount(mode || "signin");
    const dlg = $("#accountModal");
    if (!dlg.open) dlg.showModal();
  }

  function renderAccount(mode) {
    const body = $("#accountBody");
    if (account) {
      body.replaceChildren(
        h("p", { class: "eyebrow" }, "Your account"),
        h("h2", {}, account.user.username),
        h("div", { class: "stat-grid" }, statTiles(account.stats)),
        h("p", { class: "muted small-print" }, "Your stats and every puzzle you play are saved to this account."),
        h("div", { class: "modal-actions" },
          h("button", { class: "pill pill-ghost", type: "button", onclick: signOut }, "Sign out"),
          h("button", { class: "pill pill-solid", type: "button", onclick: () => $("#accountModal").close() }, "Done"))
      );
      return;
    }
    const signup = mode === "signup";
    const err = h("p", { class: "form-error", role: "alert" });
    const user = h("input", { id: "acctUser", name: "username", type: "text", autocomplete: "username", required: true,
      minlength: 3, maxlength: 20, pattern: "[A-Za-z0-9_]+", spellcheck: "false", autocapitalize: "none" });
    const pass = h("input", { id: "acctPass", name: "password", type: "password", required: true, minlength: signup ? 8 : 1,
      maxlength: 200, autocomplete: signup ? "new-password" : "current-password" });
    const submit = h("button", { class: "pill pill-solid", type: "submit" }, signup ? "Create account" : "Sign in");
    const form = h("form", {
      class: "account-form", novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        if (!user.value.trim() || !pass.value) { err.textContent = "Enter a username and password."; return; }
        submit.disabled = true;
        submit.textContent = signup ? "Creating…" : "Signing in…";
        const res = await call(signup ? "/api/signup" : "/api/login", {
          body: { username: user.value.trim(), password: pass.value, player: db.player },
        });
        submit.disabled = false;
        submit.textContent = signup ? "Create account" : "Sign in";
        if (!res.ok) { err.textContent = res.error; return; }
        applyAccount(res.data);
        $("#accountModal").close();
        toast(signup ? `Welcome, ${res.data.user.username}!` : `Signed in as ${res.data.user.username}`);
      },
    },
      h("label", { for: "acctUser" }, "Username"), user,
      signup ? h("small", { class: "hint-line" }, "3–20 letters, numbers or underscores") : null,
      h("label", { for: "acctPass" }, "Password"), pass,
      signup ? h("small", { class: "hint-line" }, "At least 8 characters") : null,
      err, submit
    );
    body.replaceChildren(
      h("p", { class: "eyebrow" }, signup ? "Create account" : "Sign in"),
      h("h2", {}, signup ? "Keep your stats everywhere." : "Welcome back."),
      h("p", {}, signup
        ? "Your streaks and scores are saved to your account. Puzzles you've already played here come with you."
        : "Sign in to pick up your streak on this device."),
      form,
      h("p", { class: "switch" }, signup ? "Already have an account? " : "New here? ",
        h("button", { class: "link inline", type: "button", onclick: () => renderAccount(signup ? "signin" : "signup") },
          signup ? "Sign in" : "Create an account"))
    );
    requestAnimationFrame(() => user.focus());
  }

  async function signOut() {
    await call("/api/logout", {});
    account = null;
    // Start fresh: the account's games stay on the server, not in this browser.
    db.player = newPlayerId();
    db.games = {};
    store.save(db);
    $("#accountModal").close();
    renderAccountBtn();
    reloadGame();
    toast("Signed out");
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
  $("#accountBtn").addEventListener("click", () => openAccount());
  for (const d of document.querySelectorAll("dialog")) d.addEventListener("click", (e) => { if (e.target === d) d.close(); });

  render();
  renderAccountBtn();
  call("/api/me", { method: "GET" }).then((res) => {
    if (!res.ok) return; // no server (static hosting): play anonymously
    serverUp = true;
    applyAccount(res.data);
  });
  tickCountdown();
  setInterval(tickCountdown, 1000);

  if (!db.seenHelp) {
    db.seenHelp = true;
    store.save(db);
    $("#helpModal").showModal();
  }
})();
