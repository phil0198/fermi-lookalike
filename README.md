# Ballpark: the daily estimation game

Three questions a day, one guess each. Every answer is a number. Your guess is scored by **how many times off** it was, so 2× too low counts the same as 2× too high. Your daily score is the geometric mean of the three ratios. Lower is better, and `1.00×` is perfect.

It has no build step and no npm dependencies. A small Node server records everyone's guesses, so the "how everyone guessed" charts show real player data.

## Run locally

Requires Node 22.5+ (it uses the built-in `node:sqlite`).

```sh
npm start          # http://localhost:3000
npm run dev        # same, restarts on file changes
npm test           # API + static-serving tests
```

| Env var | Default | |
| --- | --- | --- |
| `PORT` | `3000` | |
| `TURSO_DATABASE_URL` | unset | Hosted Turso database. When set, guesses are stored there |
| `TURSO_AUTH_TOKEN` | unset | Its auth token |
| `DB_PATH` | `./data/ballpark.db` | Local SQLite file, used when Turso isn't set (created automatically) |
| `TRUST_PROXY` | unset | Set when running behind a reverse proxy, so rate limiting uses `X-Forwarded-For` |

### Deploy for free (public website)

This setup uses two free services: [Render](https://render.com) runs the server, and [Turso](https://turso.tech) stores the guesses. Free Render servers have no disk that survives a restart, so the guesses need to live in Turso.

1. **Create the database.** Sign up at Turso (no credit card) and create a database. From the database page, copy its **URL** (`libsql://…turso.io`) and create an **auth token**. The server creates its table on first start.
2. **Push this repo to GitHub.**
3. **Deploy on Render.** Choose **New → Blueprint** and pick the repo. Render reads `render.yaml` and asks for `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`: paste the two values from step 1.
4. The game is live at `https://ballpark-xxxx.onrender.com`. The deploy log should say `Storage: Turso`.

The free Render server sleeps after 15 minutes without visitors, so the first visit after that takes about a minute to load. After that it's fast again.

Without the Turso variables, the server falls back to a local SQLite file (`DB_PATH`). That's fine for local use or for a host with a persistent disk.

### Docker

```sh
docker build -t ballpark .
docker run -p 3000:3000 -v ballpark-data:/data ballpark
```

The container starts as root only to take ownership of the mounted volume, then switches to the unprivileged `node` user before opening the database.

### Static-only

The front end still works without the server: `python3 -m http.server`, or GitHub Pages, Netlify and similar hosts. When the API can't be reached, the crowd charts fall back to a seeded **simulated** crowd, and the page labels them "simulated".

## Features

- **Home screen.** "Just ballpark it." explains the game in three steps with a worked example. Its button reads *Play today's puzzle*, *Continue*, or *See today's results*, depending on progress. Clicking the Ballpark name returns to it.
- **Daily puzzle.** It changes at midnight Eastern Time and draws 3 questions from 3 different categories. Everyone gets the same puzzle. The bank has 240 questions in 10 categories, and none repeats until all of them have been used (80 days).
- **Accounts (optional).** Sign up with a username and password to save your stats and history on the server, so they follow you to any device. Anything you played before signing up is carried into the account.
- **Flexible input.** The guess box accepts shorthand (`2.5k`, `40m`, `1.2b`) and arithmetic (`365*24`, `(12+3)*1k`). There's also a built-in scratchpad calculator.
- **Answer reveal.** You get your ratio, a "how everyone guessed" histogram, and an expandable *Napkin math* breakdown.
- **Results card.** It shows your score, percentile, a distribution chart, and a per-question breakdown. You can share it as a PNG image or copy it as text.
- **Archive.** Every past puzzle is playable from the side menu.
- **Account panel.** The round button at the top opens it. It shows your initial when signed in, and has:
  - **Stats:** played, day streak, average multiple and best day, plus a full-stats view with a score distribution and recent puzzles. Signed-in players' stats come from the server; guests' stats live in `localStorage`.
  - **Units:** imperial or metric. Tapping the unit on a question card switches it too. Answers are stored in metric and converted for display. Conversion is a fixed multiplier, so scores are identical in both systems. Temperatures stay in °C, and questions whose wording names a metric unit stay as written.
  - **Appearance:** light or dark. It follows the system until you choose.
  - **Theme:** four color palettes (Classic, Blossom, Chalk and Midnight).
  - Display settings are saved in the browser.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page shell, modals, drawer |
| `css/style.css` | All styling, built on color tokens: palettes via `data-palette`, light/dark via `data-scheme` |
| `js/theme-init.js` | Applies the saved theme before first paint |
| `js/questions.js` | Categories and the question bank (answer, unit, napkin math) |
| `js/puzzle.js` | Daily schedule (no repeats until the bank is used up), shared by the browser and the server |
| `js/app.js` | Scoring, rendering, calculator, sharing, archive, stats, API client |
| `server.js` | Static file server + JSON API |
| `store.js` | Database access: Turso over HTTP, or local SQLite |
| `test/server.test.js` | Server tests, run against both storage backends (`npm test`) |
| `test/mock-turso.js` | Local stand-in for Turso's HTTP API, used by the tests |

## Adding questions

Add entries to any category in `js/questions.js`:

```js
{ q: "How many …?", unit: "meters", a: 1234, napkin: "Short back-of-the-envelope reasoning." }
```

Each category gets used on 3 out of every 10 days, so adding questions to a category makes it last longer before repeating. **Add new questions at the end of a category's list and don't reorder existing ones.** The schedule is computed from the list order, so reordering would change which questions belong to past puzzles.

## API

Anonymous players send a random `player` id that the browser generates once and keeps in `localStorage`. Signed-in players are identified by an HttpOnly session cookie, and the server ignores any `player` id they send.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| `POST` | `/api/guess` | `{day, q, guess, player}` | That question's stats: `count`, `bins` (21 bins from answer÷10 to ×10, log scale), your `offset`, and `closerThan` (% of other players you beat) |
| `POST` | `/api/day` | `{day, guesses: [g1, g2, g3], player}` | Day stats: `count`, `bins` (1× to 1,000×), your `score` and `top` %, plus each question's stats. It also re-syncs guesses made while offline. |
| `GET` | `/api/question` | `?day&q&player` | Same as `/api/guess`, read-only |
| `POST` | `/api/signup` | `{username, password, player}` | Creates an account (adopting this browser's history) and signs in |
| `POST` | `/api/login` | `{username, password, player}` | Signs in and merges anything this browser played while signed out |
| `POST` | `/api/logout` | | Ends the session |
| `GET` | `/api/me` | | `{user: null}`, or `{user, player, history, stats}` |
| `GET` | `/api/health` | | `{ok, today}` |

Rules the server enforces:

- The **first guess wins**. A player can't overwrite an earlier answer.
- `day` must be a puzzle that has already been released.
- The server computes the error itself from its own copy of the answer.
- Request bodies are capped at 2 KB, and each IP is rate-limited (a 60-request burst, refilling at 1 per second). Sign-up and sign-in get a tighter limit (10 tries, then 1 every 6 seconds).
- Passwords are hashed with scrypt and a random salt per user. Session tokens are random, and only their SHA-256 hash is stored. Sessions last 90 days.
- An account's player id can't be used without signing in.
- Only `index.html`, `css/` and `js/` are served as static files.
