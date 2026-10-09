# Ballpark: the daily estimation game

Three questions a day, one guess each. Every answer is a number. Your guess is scored by **how many times off** it was, so 2× too low counts the same as 2× too high. Your daily score is the geometric mean of the three ratios. Lower is better, and `1.00×` is perfect.

It's a static site with no build step and no dependencies.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

You can deploy it to any static host (GitHub Pages, Netlify, Vercel, Cloudflare Pages).

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
| `js/app.js` | Puzzle selection, scoring, rendering, calculator, sharing, archive, stats |

## Adding questions

Add entries to `js/questions.js`:

```js
{ q: "How many …?", unit: "meters", a: 1234, napkin: "Short back-of-the-envelope reasoning." }
```

## Note on "how everyone guessed"

There's no backend, so the crowd histograms and percentiles come from a **simulated** crowd that is seeded per puzzle. To show real player data, POST each guess to an API and replace `crowdFor()` / `crowdScores()` in `js/app.js` with the real distributions.
