# Token plan — Instant Site Chat

Written before the CSS, per the brief. The subject is machinery working in the
open, so the crawl log is the hero and everything else gets out of its way.

## Concept

A **ledger printout**, not a dashboard. The page reads like an instrument
producing a record: hairline rules instead of cards, tabular figures that tick
over, sequential row numbers on the one thing that is genuinely sequential.
The boldness is spent entirely on the crawl log's typography and rhythm.

## Colour — 6 values

| Token | Hex | Role |
|---|---|---|
| `--paper` | `#EDF0F2` | Page ground. Cool blue-grey, the opposite end of the wheel from cream. |
| `--card` | `#F8FAFB` | Raised surfaces (log body, chat). Barely lighter than paper. |
| `--ink` | `#0F151C` | Text. Blue-shifted near-black. |
| `--rule` | `#C3CCD4` | Hairlines. The main structural device — there are no shadows anywhere. |
| `--signal` | `#1B44D8` | Instrument blue. Links, focus rings, the live cursor, active counts. |
| `--good` | `#0B6E43` | Deep green. `ok` page status only. |
| `--flag` | `#9B2C1E` | Oxide red. `empty` / `error` / `skipped` status only. |

`--good` and `--flag` are status-only and never decorative, so the page reads
as two-colour (ink on paper) with blue as the single active accent.

Dark mode inverts `--paper`/`--ink` and lifts `--signal` to `#7D9BFF`.

## Type — 2 families

- **IBM Plex Sans** — prose, headings, buttons. An engineering grotesque; it
  reads as instrumentation rather than as a startup landing page.
- **IBM Plex Mono** — the crawl log, all figures, URLs, the embed snippet.
  `font-variant-numeric: tabular-nums` everywhere a number changes, so counts
  tick in place instead of jittering.

Roles: display 30px/1.15 medium · body 15px/1.55 regular · log 13px/1.5 mono ·
label 12px mono, sentence case.

**No tracked-out all-caps eyebrows.** Labels are sentence-case mono, e.g.
`pages fetched`, not `PAGES FETCHED`.

## Layout

### Input
```
┌────────────────────────────────────────────────────────┐
│                                                        │
│   Point this at your website.                          │
│   It reads it, then you can ask it things.             │
│                                                        │
│   ┌──────────────────────────────┬───────────────┐     │
│   │ your-site.com                │  Read it  →   │     │
│   └──────────────────────────────┴───────────────┘     │
│                                                        │
│   or try  kleiosoftware.com  11ty.dev  danluu.com      │
│                                                        │
│   up to 25 pages · expires in 24 hours · no account      │
└────────────────────────────────────────────────────────┘
```

### Indexing — the hero
```
┌────────────────────────────────────────────────────────┐
│  kleiosoftware.com                          00:07.4    │
│  ────────────────────────────────────────────────────  │
│  reading sitemap                                       │
│                                                        │
│    17 pages       245 chunks        6 queued           │
│  ────────────────────────────────────────────────────  │
│  17 │ /work/kinefolk-studio    Kinefolk Stu…    4207 │ │ ← arrives
│  16 │ /faq                     FAQ: Custom W…  18795 │ │
│  15 │ /services/custom-ai-mo…  AI Programmer…   8537 │ │
│  14 │ /resources               Resources: Gu…    226 │ │
│     ⋮  (older rows fade out below 12)                  │
└────────────────────────────────────────────────────────┘
```
Row numbers are earned here: the crawl genuinely is sequential. Char counts are
right-aligned in a fixed column so the ragged edge shows page-size variance at a
glance — the log looks like output, not like a list of features.

### Chat
```
┌──────────────────────┬─────────────────────────────────┐
│ indexed · 17         │  kleiosoftware.com              │
│  /                   │  ─────────────────────────────  │
│  /faq                │  › is Kleio a one-person studio?│
│  /work/kinefolk-st…  │                                 │
│  /services/…         │  Yes — the same person does the │
│  ⋮                   │  design and writes the code.[1] │
│                      │  ┌─────────┐                    │
│  ──────────────────  │  │ /faq  ↗ │                    │
│  <script src=…>      │  └─────────┘                    │
│  [ copy ]            │  ┌───────────────────────┬────┐ │
│                      │  │ ask something         │ →  │ │
│  expires in 24h      │  └───────────────────────┴────┘ │
└──────────────────────┴─────────────────────────────────┘
```

## Motion

Only where something actually changed:
- a new log row: 120ms background wash from `--signal` at 8% to transparent
- a count increment: no transition, tabular figures swap in place
- streaming answer text: appears as it arrives, no typewriter simulation
- the live cursor: a 1s step blink on the current stage line

No fade-and-slide-up on sections. No progress bar — the real numbers moving are
the point, and an invented percentage would undercut the whole premise.
All of it inside `prefers-reduced-motion: reduce` guards.

## Checked against the brief's exclusions

| Excluded | This page |
|---|---|
| Cream `#F4F1EA` + terracotta | Cool blue-grey paper, instrument blue |
| Near-black + one acid accent | Light ground, no neon anywhere |
| Tracked-out all-caps eyebrows | Sentence-case mono labels |
| `01 / 02 / 03` markers | Only in the crawl log, where order is real |
| Identical rounded cards, soft grey shadow | Hairline rules, `border-radius: 2px`, zero shadows |
| Fade-and-slide-up on every section | Motion only on genuine change |
