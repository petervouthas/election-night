# Election Night 2026 dashboard

Local dashboard for the Nov 3, 2026 midterms. One Node server, one page, no
dependencies, no build step.

## Start

```
./run.sh
```

(`node server.js` alone also works; `run.sh` restarts it if it ever dies and
logs to `server.log`.) To drop a test player from the game without a restart:
`curl "localhost:3000/api/game/remove?id=<id>"` (works only from this Mac; ids
are in `cache/game.json`).
Then open http://localhost:3000. Node 18 or newer is required (uses global `fetch`).
Guests on the same Wi‑Fi use `http://<this Mac's LAN address>:3000` (find it with
`ipconfig getifaddr en0`); phones get the data views without the stream.

Before the night: delete any leftover `cache/snapshot-*.json` from testing
(the 6pm and midnight snapshots are labeled without a date) and, if you want a
clean leaderboard, `cache/game.json`.

## What it shows

- **Top bar**: House and Senate control odds from Kalshi and Polymarket side by
  side, the spread between them, a two-hour sparkline, and the NYT/AP called-seat
  count for each chamber.
- **Bellwether table**: the races in `config.json`, sorted by poll close. Columns
  are poll close (ET), Kalshi and Polymarket Democratic win probability, the 2024
  presidential margin, the live margin, and the over/underperformance (live minus
  2024). The `signal` column says what each race is a bellwether for.
  - Margins are always Democratic minus Republican, shown as `D+3.2` or `R+1.5`.
  - Overperformance is from the Democratic perspective: green means Democrats are
    running ahead of the 2024 presidential result, amber means behind.
  - The 2024 margin fills from the NYT feed; the live margin fills from the vote
    count. Click either cell to type your own number. Edits persist in
    `localStorage`. Clear a cell to go back to the feed value.
- **Table datasets**: buttons above the table switch between the bellwethers,
  the key Senate races and key House races (any NYT rating other than solid),
  and the full Senate (35) and House (435) lists. Non-bellwether rows use the NYT rating as
  their signal and pull Kalshi and Polymarket odds where a market exists (the
  server fetches odds for every Senate race and every competitive House race;
  set `extraMarkets` in `config.json` to `all` for all 435 or `none` to skip).
  Click any header to sort; click again to flip. Drag a header to reorder
  columns. The `Columns` button picks which columns show (normal and theater
  layouts keep separate sets); Democrat / Republican candidate name and share
  columns are on by default. Click a race id for the detail modal (mini map,
  candidates, count, markets, polls, spending, counties, a short district
  description from Wikipedia). `?modal=NY-17` opens one on load.
  The sort, dataset, order and column choices persist.
- **Generic ballot projection**: a uniform-swing estimate. It takes the
  vote-weighted average of (live margin minus 2024 margin) across bellwethers
  that have votes in, and adds it to the 2024 national popular vote margin
  (R+1.5). Next to it is the latest generic-ballot polling average from VoteHub
  so you can see whether the bellwethers are breaking better or worse than polls.
- **Seats**: every House seat (435) and Senate seat (100) as tiles, filled as
  races are called, with leaders shown in a lighter shade. Majority line marked.
- **Map**: US map colored by Senate race status, or by net House seats per
  state. Hover a state for the races. Toggle **Polls** to color by the latest
  polling average instead, so you can compare poll margin to live margin.
- **Map layers**: Senate, Governor, House net (per state), and **Districts**, the
  real 2026 congressional boundaries from the Census Bureau's 120th-Congress
  TIGER files (ten states redrew mid-decade: AL, CA, FL, LA, MO, NC, OH, TN, TX,
  UT; all included). Before any votes are in, districts are tinted faintly by
  NYT rating. Sources per state are in `public/vendor/GEOMETRY-SOURCES.md`.
- **Cartogram**: one square per House seat, each state a block proportioned
  roughly like the state, arranged like the familiar state tile grid (the New
  York Times election cartogram style). Same color modes as the map; the
  district order inside a block follows The Downballot's congressional district
  hexmap (CC BY 4.0, the-db.co/maps). The Senate and Governor layers of the
  cartogram are a 50-state tile grid, one labelled square per state; click a
  tile for the race. Zoom works on every map and cartogram.
- **Map modes**: Live (counted votes only; gray until votes arrive), Markets
  (Democratic win probability from Kalshi, Polymarket, or their average; every
  Senate race plus competitive House seats), Polls, Live minus polls, Ratings
  (NYT ratings), Spending.
- **Zoom**: scroll wheel or the `+` / `−` buttons zoom, drag to pan, `Fit`
  resets. The map sizes itself to the region, so drag the divider above it (or
  switch to Theater) for a bigger map.
- **Spending** (map mode): FEC candidate-committee disbursements plus outside
  independent expenditures for the 2025–26 cycle. `Total $`, `D $` and `R $`
  shade by dollars (square-root scale, darkest = most); `Share` shows who
  outspent whom in party color. Hover for dollar totals. Each bellwether row
  also shows total spend next to its name, with the D/R breakdown in the
  tooltip. FEC covers federal races only, so the Governor layer has no spending.
- **Theater**: the `Theater` button (or the `T` key) makes the stream fill the
  height, with control odds, seat bars and the generic-ballot projection in a
  strip underneath and a compact race table in a narrow sidebar.
- **Text size**: `A−` / `A` / `A+` in the header scale every font on the page
  and in the modal (10% steps, persisted; `?ui=1.3` sets it in the URL). Around
  130–150% reads well from a couch.
- **Full screen**: the `Full screen` button (or the `F` key) uses the browser's
  full-screen mode; Esc leaves. On macOS, Control+Command+F does the same at the
  window level and hides Safari's tab bar.
- **Layout**: the header and odds bar are locked; the table, the seats/map area,
  the polls list and the log each scroll on their own. Drag the handle between
  the columns, between the table and the seats/map area, or between polls and
  log to resize; drag a table header's right edge to resize that column.
  Double-click a handle to reset it, or use `Reset layout` in the header to
  reset everything. Sizes persist in `localStorage`.
- **Deep links**: `?view=map&layer=senate&mode=polls` or `?theater=1` open the
  page in that state.
- **Feed**: the panel under the stream lists every event the server detects
  from the results and odds feeds: AP calls (with FLIP tags when the seat
  changes party), lead changes once 15% is in, bellwethers crossing their 2024
  margin, first votes in a bellwether, odds moves of 5+ points in 30 minutes,
  and chamber control calls. Filter chips, a 🔔 sound toggle (chimes for calls,
  flips, control and crossings; click the page once first so the browser allows
  audio), and a `Tape` toggle for a ticker along the bottom that turns itself on
  at the first event. Rows in the race table flash when their race has an event.
  Coming back after 3+ minutes away shows a catch-up toast.
- **Watch**: a poll-closing timeline. Each closing time lists the states, the
  bellwethers and the other key races it unlocks, with market odds and live
  status, and the next close is highlighted.
- **Movers**: the biggest odds movers over 15 min to 2 h, or versus the 6pm and
  midnight snapshots, ranked by log-odds change, with sparklines and a
  "pre-call" tag when the market moved before AP called the race.
- **Snapshots**: the server saves full odds and results snapshots at 6:00 PM
  and midnight ET (`snapshotTimesET` in config) into `cache/`, up to 30 minutes
  late if the laptop was asleep, and `GET /api/snapshot?label=whatever` takes
  one on demand.
- **Game**: a predictions game for guests, in its own full-page panel (the
  `Game` button in the header, or the `G` key; Esc closes). First-time guests on
  a phone or another computer get a short onboarding: name and home zip, then
  generic ballot, House seats, Senate seats, and an optional Senate map, one
  question per screen (`?join=1` opens it anywhere; it never auto-opens on the
  TV at localhost). A token in their browser lets them edit their own entry,
  including name and hometown. Picks are the 35 Senate races (tap the tile map
  or use the list); entries lock at the
  time in `config.json` → `game.lockET` (default 19:00 ET, `allowLate: true`
  to keep editing open). The leaderboard scores live from AP calls: one point
  per correct call, ties broken by fewer misses then seat-total error. Tap a
  player to see their map with correct picks in green and misses in amber.
  Entries persist in `cache/game.json`. Joining requires a home zip code
  (`game.requireZip: false` in config to make it optional): the server looks it
  up in the bundled GeoNames zip table (`data/us-zips.tsv`, CC BY 4.0) for the
  town and county, then drops the point into the real 2026 district geometry to
  find the House district. The **Hometowns** dataset in the race table lists
  each guest's House race plus their state's Senate and Governor races, with
  the guests' names and towns in the signal column.
- **Setups**: everything you arrange (panel sizes, columns, dataset, sort, text
  size, theater, map modes) persists in the browser automatically. `Save setup`
  in the header stores it under a name on the server; open the page with
  `?setup=name` on any device to apply it.
- **Phone**: on a narrow screen the page becomes an app with a bottom tab bar:
  Game, Odds (control odds, seat bars, links, log), Races (the table, scrolls
  sideways with the race id pinned, fewer columns by default; the Columns
  button still works), Map (seats, map, cartogram, watch, movers) and Feed.
  Open `http://<this Mac's LAN address>:3000` on the same Wi‑Fi. There is no
  stream on phones.
- **Stream**: tabs for Twitch (hasanabi) and ABC News Live.
- **Links**: DDHQ, NYT, AP, @Redistrict.
- **Log**: fetch errors from every source, newest first. Nothing crashes the page.

## Data sources (all public, verified live on Nov 2, 2026)

| Source | Endpoint | Used for |
|---|---|---|
| Kalshi | `api.elections.kalshi.com/trade-api/v2/markets?tickers=...` | control odds, race odds |
| Polymarket | `gamma-api.polymarket.com/events?slug=...&slug=...` | control odds, race odds |
| NYT results | `static01.nyt.com/elections-assets/pages/data/2026-11-03/results-{house,senate}.json` | live votes, calls, 2024 margins, counties |
| VoteHub | `api.votehub.com/polls` | polling averages (generic ballot, Senate, House, governor, Trump approval) |
| FEC bulk | `fec.gov/files/bulk-downloads/2026/weball26.zip`, `.../independent_expenditure_2026.csv` | spending map (cached in `cache/`, refreshed every 6 h) |

Measured latency on Nov 2: Kalshi ~0.1 s, Polymarket ~0.3 s, NYT House file
~1 s (7 MB), NYT Senate/Governor ~0.3 s, VoteHub ~8 s (3 MB, so it refreshes
every 10 min), FEC ~12 s once (cached).

Kalshi has no market for FL-14 or FL-22, so those cells show "—".

## Tweaking tonight

Everything lives in `config.json` and is re-read automatically when the file
changes (no restart needed):

- `pollIntervalMs`: market poll interval (default 30000). `nytIntervalMs` is the
  slower results-feed interval (default 60000; the House file is ~7 MB).
  `pollsIntervalMs` is the VoteHub refresh (default 600000).
- `races`: add or remove rows. Each row needs an `id`, `office`, `state`,
  `pollCloseET`, `signal`, and the three source ids:
  - `nyt`: NYT race id, pattern `ST-G-H-<district>-2026-11-03` for House,
    `ST-G-S-2026-11-03` for Senate.
  - `kalshi`: the Democratic-side market ticker, pattern `HOUSE<ST><district>-26-D`
    or `SENATE<ST>-26-D`. Set to `null` if there is no market.
  - `polymarket`: the event slug, pattern `st-NN-house-election-winner` or
    `<state-name>-senate-election-winner`.
  - `margin2024`: leave `null` to use the NYT value, or set a number (D minus R).
- `embeds`: the Twitch and ABC iframe URLs. If ABC's live embed is blank, replace
  the URL with `https://www.youtube.com/embed/<videoId>` of the live broadcast.
- `links`: the quick-link buttons.

Hit `GET /api/refresh` to force an immediate re-poll. `GET /api/state` is the
raw JSON the page uses.
