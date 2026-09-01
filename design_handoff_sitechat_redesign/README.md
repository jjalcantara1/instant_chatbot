# Handoff: Site Chat redesign (input → crawl → chat, plus widget)

## Overview
Site Chat takes a URL, crawls up to 25 pages, and turns them into a chatbot the visitor can question immediately. This handoff covers a full visual redesign of the three existing screens (URL input, live crawl, chat), plus the states the current build lacks (empty transcript, failed crawl, 390px layout) and a restyled embeddable widget.

The redesign replaces the boxed-input / grey-panel look with a hairline-ruled layout on warm paper, one accent, and a clear type hierarchy where the answer is the most important thing on the chat screen.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior. They are not production code to copy.

The task is to **recreate these designs in the existing codebase**: `jjalcantara1/instant_chatbot`, `web/` — Vite + React 18 + TypeScript + Tailwind, with CSS custom properties in `web/src/index.css`. Keep the current architecture (`App.tsx` view state machine, `CrawlLog.tsx`, `Chat.tsx`, `api.ts` SSE plumbing, `widget/src/widget.ts` shadow-DOM widget) and change only presentation. No new dependencies are required beyond two webfonts.

## Fidelity
**High-fidelity.** Colors, type sizes, weights, letter-spacing, rules and spacing below are final and should be matched. Where a number is not given, follow the nearest equivalent in the reference file.

The design file is a review canvas containing three rounds of exploration. **Build turn 3, option `3a` only** (`#3a` in `SiteChat Redesign.dc.html`). Turns 1 and 2 are rejected earlier directions kept for reference — do not implement them.

## Design Tokens

Replace the current `:root` block in `web/src/index.css`.

| Token | Value | Role |
|---|---|---|
| `--paper` | `#F7F5F1` | Page ground (warm off-white) |
| `--card` | `#FDFCFA` | The one raised surface: embed-snippet box |
| `--ink` | `#17150F` | Text, and the 2px rule under an active input |
| `--muted` | `#6B665C` | Secondary text, labels, char counts, row indices, placeholders |
| `--rule` | `#DCD7CD` | Every hairline (1px). There are no shadows in the app UI |
| `--accent` | `#5B2A86` | Purple. Links, action words, live caret, newest-row marker, footnote numbers, focus ring |
| `--accent-wash` | `rgba(91,42,134,.07)` | Background of the newest crawl row only |
| `--flag` | `#9B2C1E` | Error codes, unreadable-page status |

Rules: exactly one accent. No gradients, no border-radius anywhere in the app UI (the widget launcher circle is the sole exception), no box-shadows, no pill/chip shapes, no emoji, no icon set. Status red is functional only, never decorative.

### Typography
- **Archivo** (Google Fonts, weights 400/500/600) — everything.
- **System monospace** (`ui-monospace, Menlo, monospace`) — URLs, paths, row indices, timers, char counts, the embed snippet. No webfont needed.
- `font-variant-numeric: tabular-nums` on every figure that changes (timer, counts, message counter).

| Role | Size / weight / spacing |
|---|---|
| Display (input h1) | 62px / 600 / -0.035em / line-height 1.04 |
| Crawl stage line | 38px / 500 / -0.028em / line-height 1 |
| Crawl stat numerals | 44px / 600 / -0.03em / line-height .9 |
| Error headline | 30px / 600 / -0.028em / line-height 1.2 |
| Chat domain (h1) | 22px / 600 / -0.02em |
| **Answer body** | **17.5px / 400 / -0.006em / line-height 1.6** |
| Input placeholder (URL) | 28px mono, `--muted` |
| Input placeholder (question) | 18px, `--muted` |
| Body / sub | 15px / line-height 1.5, `--muted` |
| Crawl log row | 13.5px mono |
| Labels, meta | 12px |
| Message counter, footnote index | 11–11.5px |

Do not scale the answer up: it was deliberately brought down from a display size so it reads as an answer, not a headline.

### Spacing
Page gutters 48px desktop / 18px mobile. Vertical rhythm in multiples of 4: 8, 12, 16, 22, 24, 28, 34, 52. Rule-to-content padding 12–18px. Log row padding 14px vertical.

## Screens / Views

### 1. Input — `App.tsx`, `view.kind === 'input'`
Full-height flex column on `--paper`.

- **Top bar**: `padding: 22px 48px`, `border-bottom: 1px solid --rule`. Left: "Site Chat", 14px/600/-0.01em. Right: "25 pages max · expires in 24 hours · no account", 12px `--muted`.
- **Centre block** (vertically centred, 48px gutters):
  - h1 "Point this at your website." — display scale, `max-width: 720px`, `text-wrap: pretty`.
  - Sub "It reads the pages, then you can ask it things. Watch it work." — 17px `--muted`, `max-width: 460px`, 20px above.
  - **Field row**, 52px above, `display: flex; align-items: flex-end; gap: 28px; max-width: 860px`. The input is *not* a box: transparent background, no border except `border-bottom: 2px solid --ink`, `padding-bottom: 12px`, 28px mono text. Placeholder `your-site.com` in `--muted`. A 2px × 26px `--accent` block sits at the caret position, blinking 1.1s `steps(1)` (this is decorative in the mock; in the build let the real text cursor do the work and drop the fake caret, or keep it only while the field is empty and unfocused).
  - **Submit** "read it →" — text-only, 17px/500 `--accent`, `border-bottom: 2px solid --accent`, `padding-bottom: 12px`. Disabled: opacity .4. Busy label: "starting…".
  - **Examples row**, 24px above: "or try" 13px `--muted`, then the three example links, 13px mono `--ink`, underlined with `text-decoration-color: --accent`, `text-underline-offset: 4px`. Clicking one fills the field and submits (current behavior).
  - **Inline error** (bad URL, blocked domain): 13px `--flag`, directly under the field row.

### 2. Crawl — `CrawlLog.tsx`, `view.kind === 'indexing'`
Full screen, no card. This is the state the user waits in, so it must feel like output.

- **Head row**: `padding: 22px 48px 20px`. Left: domain, 14px mono. Right: elapsed `00:07.4`, 14px mono `--muted`, tabular.
- **Stage row**: `padding: 0 48px 28px`, `border-bottom: 1px solid --rule`, `display: flex; align-items: flex-end; justify-content: space-between`.
  - Left: current stage label at 38px/500 (`resolving address`, `reading robots.txt`, `reading sitemap`, `crawling`, `building index`, `waiting for a free slot`, `ready` — existing `STAGE_LABEL` map), followed by a 3px × 28px `--accent` blinking block.
  - Right: three counters, `gap: 52px` — value at 44px/600 tabular, label 12px `--muted` 9px below. Order: `pages read`, `chunks built`, then `in queue` or `embedded` (existing swap logic). A zero/idle counter takes `--muted` for its value.
- **Log**: rows in `padding: 0 48px`, newest first, max 12 visible.
  - Grid `30px 320px 1fr 92px`, `gap: 0 20px`, `align-items: baseline`, 14px vertical padding, `border-top: 1px solid --rule`, 13.5px.
  - Columns: index (mono, right-aligned, tabular, `--muted`), path (mono), page title (`--muted`, truncated), char count (mono, right-aligned, tabular).
  - **Newest row**: background `--accent-wash`, `box-shadow: inset 3px 0 0 --accent`, index in `--accent`, 14px padding all round with -14px horizontal margin so the marker sits in the gutter. No `border-top`.
  - Failed page: path/title/count in `--flag`, count renders `—`, title renders `no readable text` / `skipped` / `could not read` (existing `statusNote`).
  - Older rows fade: rows 6, 7, 8 at opacity .55, .25 — a simple ramp, not a mask.
- **Transition to chat** (`onReady`): the whole crawl screen slides up and out over 240ms `cubic-bezier(.2,.7,.3,1)` while the chat screen fades in; the indexed page list in the chat sidebar is the same data, so it should feel like the log docking into the sidebar. Respect `prefers-reduced-motion: reduce` — cross-fade only, 120ms.

### 3. Chat — `Chat.tsx`, `view.kind === 'chat'`
Desktop grid `236px 1fr`, full height, only the transcript scrolls.

**Sidebar** — `border-right: 1px solid --rule`, `padding: 26px 24px`, flex column.
- "indexed · 8" 12px `--muted`.
- Path list 12px mono, `gap: 7px`, truncated, `--ink`, no underline; hover → `--accent`. The page cited by the current answer is shown in `--accent` + underline.
- Pushed to the bottom (`margin-top: auto`): a `border-top` rule, then "put this on your site" 12px `--muted`; the snippet in a 1px `--rule` box on `--card`, 10px mono, `word-break: break-all`; "copy" 12px `--accent` underlined (→ "copied" for 1.8s); then the expiry note, 12px `--muted`, with "talk to Kleio" in `--accent` underlined.

**Main column**
- **Header**: `padding: 26px 44px 20px`, `border-bottom`. Left: domain 22px/600/-0.02em, then "Reading 8 pages. Ask it something you already know the answer to." 13px `--muted`. Right: "← index a different site", 12px `--muted` underlined (currently a footer button — move it here).
- **Transcript**: `padding: 30px 44px`, scrolls.
  - Question: 14px `--muted`, plain — no `›` marker, no bubble, no background.
  - Answer: 17.5px/1.6, `max-width: 640px`, `text-wrap: pretty`, 16px below the question. Streams token by token; a 2px `--accent` caret block trails the text while streaming.
  - Citation markers `[n]` render as `<sup>` 11px `--accent`, `top: -0.8em`.
  - **Sources as footnotes** (this replaces the current bordered path chips): 28px below the answer, `border-top: 1px solid --rule`, `padding-top: 12px`, `max-width: 640px`. Each source is a row: `gap: 14px`, index 11px mono `--accent`, then the path 12.5px mono underlined in `--accent` (`text-underline-offset: 4px`) with the page title beneath at 12px `--muted`. Multiple sources stack with 12px gaps, ordered by citation number.
  - **Thinking state**: the stage label ("searching the indexed pages" / "writing an answer") at 14px `--muted` in the answer's place, followed by a blinking `--accent` caret. Keep the existing animated ellipsis but make it non-animated under reduced motion.
  - **Empty state**: "Nothing asked yet." 14px `--muted`, then a suggested-question list 24px below, `max-width: 540px`, hairline top and between rows: each row 14px vertical padding, question 15px `--ink` left, "ask →" 12px `--accent` right, whole row clickable. **The three questions in the mock are placeholder** — generate them server-side from indexed page titles, or drop the list and keep only the line of copy.
- **Composer**: `padding: 0 44px 26px`. `border-top: 1px solid --rule`, `padding-top: 18px`. Same bare-underline treatment as the URL field: 18px text, `border-bottom: 2px solid --ink`, submit "ask" 15px/500 `--accent` with a 2px accent underline. Below, 11.5px `--muted` tabular: "87 messages left in this demo session" / "No messages left in this demo session". At the cap the field is disabled (opacity .6) and the placeholder becomes "Message limit reached for this session".

### 4. Error — `App.tsx`, `view.kind === 'failed'`
Same top bar as the input screen; content vertically centred, 48px gutters.
- Error code, 12px mono `--flag`, lowercased (`robots_disallowed`, `blocked_domain`, `fetch_failed`…).
- Message from the API at 30px/600/-0.028em, `max-width: 660px`. The mock shows a sample string; always render `err.message`.
- Explanatory line 15px `--muted`, `max-width: 460px` — "Nothing was stored. Point it at a different address, or at a page you control."
- Actions 34px below, `gap: 28px`: "try another site" 16px/500 `--accent` with a 2px accent underline (resets to input), and a 13px `--muted` underlined link to what the crawler does and does not fetch.

### 5. Mobile / narrow (< 768px)
One column, 18px gutters, page scrolls (keep the current `min-h-full md:h-full` split).
- **Input**: top bar collapses to "Site Chat" + "25 pages max". h1 drops to 40px/600/-0.032em. URL field 19px mono. Submit becomes a full-width bordered action: `1px solid --accent`, 14px vertical padding, centred 16px/500 `--accent` text — the only place a bordered button exists, because a text link is too small a target. Examples wrap with 14px gaps.
- **Chat**: no sidebar. Header shows domain 17px/600 with "change site" 11.5px `--muted` at the right; below it "8 pages indexed" 12px `--muted` and "see the list ↓" in `--accent`, which expands the indexed paths inline (collapsed by default). Answer 16.5px/1.6. Footnote row truncates the path with ellipsis. Composer pinned at the bottom of the flow with the same bare-underline treatment; meta line reads "87 messages left · expires in 24 hours". The embed snippet moves below the transcript, after the footnotes.
- **Crawl on mobile**: keep the existing 3-column log (`2rem 1fr 4.5rem`, title hidden). Stage line drops to 26px, counters stack into a row of three at 30px.
- Minimum tap target 44px for every link and action on mobile.

### 6. Embeddable widget — `widget/src/widget.ts`
Shadow DOM, same bootstrap and API. Restyle only.
- **Launcher**: 52px circle, `1px solid --ink`, background `--paper`, glyph in `--accent`, no drop shadow (the current `0 4px 14px` goes). Hover: border and glyph `--accent`.
- **Panel**: `min(370px, calc(100vw - 32px))` × `min(480px, calc(100vh - 110px))`, background `#FFFFFF` (it sits on someone else's page, so white, not warm paper), `1px solid --ink`, **`border-radius: 0`**, no shadow.
- **Header**: `padding: 13px 15px`, `border-bottom: 1px solid --rule`. "Ask about this site" 13.5px/600; sub "8 pages from kleiosoftware.com" 11px `--muted`. Close `×` 17px `--muted`.
- **Log**: `padding: 15px`. Question 12.5px `--muted` plain — **remove the accent-filled user bubble entirely** (no `border-radius: 12px 12px 2px 12px`, no reversed-out text). Answer 14.5px/1.6 with `<sup>` markers in `--accent`. Sources become one footnote row per source: hairline top, 10.5px mono index in `--accent`, path 11.5px mono underlined, truncated — replacing the current bordered chips.
- **Composer**: `border-top`, bare underline field (`2px solid --ink`), 14.5px, submit "ask" 13.5px/500 `--accent` underlined. Rounded 6px inputs and `--card` fills go.
- **Notices** (expired / 410 / 404): 13px `--muted`, centred, `padding: 20px 16px`, link in `--accent`. Copy unchanged.
- Keep every behavior already implemented: focus trap, Escape to close, `aria-expanded`, focus returning to the launcher, SSE token/sources/error events, 1000-char max, disabled state while busy.
- The widget's `prefers-color-scheme: dark` block can stay as-is for now; a matching dark palette for the app is out of scope for this pass.

## Interactions & Behavior
- Input → crawl → chat is the existing three-state machine; no route changes. `?s=<sessionId>` resume behavior stays.
- The only animations: the blinking accent caret (1.1s `steps(1)`), the newest-log-row wash (900ms ease-out, one shot), and the crawl→chat slide (240ms). No fade-up on load, no progress bar (the real counters are the progress), no skeletons.
- Hover: links gain `--accent`; sidebar paths gain `--accent`; text actions gain nothing beyond their existing underline. No transforms, no shadows, no background changes on hover.
- Focus: `outline: 2px solid --accent; outline-offset: 2px` on every focusable element (already in `index.css`).
- All motion inside `@media (prefers-reduced-motion: reduce)` guards, as today.
- Contrast floor: body and data text at 4.5:1, large text at 3:1. `--muted` (#6B665C) is the lowest grey permitted for anything carrying information — do not reintroduce lighter greys for row indices, char counts or counters.

## State Management
No changes. Existing state is sufficient: `view` (`input | indexing | chat | failed`), `url`, `submitting`, `inputError`, `pages`, `chunks`, `embedded`, `queued`, `stage`, `domain`, `startedAt` in `App.tsx`; `turns`, `input`, `busy`, `stage`, `used`, `capped` in `Chat.tsx`. Two additions for the redesign: a boolean for the mobile "see the list" disclosure, and (only if suggested questions ship) a list of generated starter questions on the session payload.

## Assets
None. No images, no icon set, no logo files. The single glyph in the widget launcher is the existing inline SVG in `widget.ts`. Placeholder blocks in the widget mock represent the customer's own page and are not part of the build.

Fonts: **Archivo** 400/500/600 from Google Fonts (self-host or `<link>`); monospace is the system stack. The current IBM Plex Sans/Mono pair is no longer used and can be dropped.

## Files
- `SiteChat Redesign.dc.html` — the design reference. Open it in a browser; it is a review canvas with three turns. **Build option `3a` (turn 3, top of the file)**: frames 01 input, 02 crawling, 03 chat, 04 chat empty, 05 error, 06 mobile, 07 widget. Turns 2 and 1 below it are earlier rejected directions (sans and serif explorations) — reference only.
- Existing files to change: `web/src/index.css` (tokens, log row, fonts), `web/src/App.tsx` (input, error, transition), `web/src/CrawlLog.tsx` (head, stats, log rows), `web/src/Chat.tsx` (sidebar, header, footnotes, composer, empty state), `widget/src/widget.ts` (shadow styles only).
