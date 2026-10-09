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
| `DB_PATH` | `./data/ballpark.db` | SQLite file (created automatically) |
| `TRUST_PROXY` | unset | Set when running behind a reverse proxy, so rate limiting uses `X-Forwarded-For` |

### Deploy (public website)

The repo includes a [Render](https://render.com) Blueprint (`render.yaml`):

1. Push this repo to GitHub.
2. In Render, choose **New → Blueprint** and pick the repo. Render builds the `Dockerfile` and attaches a 1 GB disk at `/data` for the database.
3. When the deploy finishes, the game is live at `https://ballpark-xxxx.onrender.com`. To use your own domain, go to **Settings → Custom Domains**.

The disk needs a paid instance (Starter, about $7/month). On a free instance the database is wiped every time the service restarts or redeploys.

Any host that runs a Dockerfile with a persistent volume works the same way, for example Railway or Fly.io. Mount the volume at `/data`, and set `TRUST_PROXY=1` when the host puts a proxy in front of the app.

### Docker

```sh
docker build -t ballpark .
docker run -p 3000:3000 -v ballpark-data:/data ballpark
```

The container starts as root only to take ownership of the mounted volume, then switches to the unprivileged `node` user before opening the database.

### Static-only

The front end still works without the server: `python3 -m http.server`, or GitHub Pages, Netlify and similar hosts. When the API can't be reached, the crowd charts fall back to a seeded **simulated** crowd, and the page labels them "simulated".

## Features

- **Daily puzzle.** It changes at midnight Eastern Time and draws 3 questions from 3 different categories. The selection is seeded, so everyone gets the same puzzle.
- **Flexible input.** The guess box accepts shorthand (`2.5k`, `40m`, `1.2b`) and arithmetic (`365*24`, `(12+3)*1k`). There's also a built-in scratchpad calculator.
- **Answer reveal.** You get your ratio, a "how everyone guessed" histogram, and an expandable *Napkin math* breakdown.
- **Results card.** It shows your score, percentile, a distribution chart, and a per-question breakdown. You can share it as a PNG image or copy it as text.
- **Archive.** Every past puzzle is playable from the side menu.
- **Stats.** Tracks games played, average, best, and streaks, stored in `localStorage`.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page shell, modals, drawer |
| `css/style.css` | All styling (coral question card, yellow results card, responsive) |
| `js/questions.js` | Categories and the question bank (answer, unit, napkin math) |
| `js/puzzle.js` | Daily puzzle selection, shared by the browser and the server |
| `js/app.js` | Scoring, rendering, calculator, sharing, archive, stats, API client |
| `server.js` | Static file server + JSON API + SQLite storage |
| `test/server.test.js` | Server tests (`npm test`) |

## Adding questions

Add entries to `js/questions.js`:

```js
{ q: "How many …?", unit: "meters", a: 1234, napkin: "Short back-of-the-envelope reasoning." }
```

## API

Every request carries a random `player` id that the browser generates once and keeps in `localStorage`. Accounts aren't needed.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| `POST` | `/api/guess` | `{day, q, guess, player}` | That question's stats: `count`, `bins` (21 bins from answer÷10 to ×10, log scale), your `offset`, and `closerThan` (% of other players you beat) |
| `POST` | `/api/day` | `{day, guesses: [g1, g2, g3], player}` | Day stats: `count`, `bins` (1× to 1,000×), your `score` and `top` %, plus each question's stats. It also re-syncs guesses made while offline. |
| `GET` | `/api/question` | `?day&q&player` | Same as `/api/guess`, read-only |
| `GET` | `/api/health` | | `{ok, today}` |

Rules the server enforces:

- The **first guess wins**. A player can't overwrite an earlier answer.
- `day` must be a puzzle that has already been released.
- The server computes the error itself from its own copy of the answer.
- Request bodies are capped at 2 KB, and each IP is rate-limited (a 60-request burst, refilling at 1 per second).
- Only `index.html`, `css/` and `js/` are served as static files.
