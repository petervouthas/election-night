# Election Night dashboard: creative, glanceable additions

Scope: one viewer, laptop next to a TV. Ideas use only data already flowing through `/api/state`, `/api/seats` and `/api/spending`, or sources marked LIVE in DATASOURCES.md. Effort assumes a developer who knows this codebase (one `server.js`, one `public/index.html`, no build step).

## What I checked in the live data (Nov 2, ~11pm ET)

- **Already there but unused:**
  - Every race has `inPartyControl`, `rating`, `eevp`, `expectedVotes`, `precinctsReporting/Total`, `providerUpdatedAt` and `callStatus`.
  - `nyt.control` carries `flipsD/flipsR` and `currentControl` (House D214/R218/O1).
  - `nyt.pollClosing` has 51 states with UTC times.
  - `/api/seats.markets` has Kalshi and Polymarket D-probability for every Senate race and every competitive House race.
  - Polls include `trumpApproval` (net −19.3), the generic ballot (D+7.4) and `primary2028`.
  - Spending has `topCandidates` and `topSpenders`.
- **House county units carry 2024 county margins.** In the raw NYT House file, county `reporting_units` have `historical_comparison_race_data` `{pct_dem, pct_rep, margin}` (for example, PA-7 Carbon County R+34.8). `condenseRace()` throws this away; it keeps only the live county margin. One added line in `server.js` keeps it, and that enables county benchmarks.
- **Senate counties are missing.** The NYT Senate file currently has only state-level units (GA-Sen has `level: state` only), so the Senate has no NYT county data yet. They may appear on the night. If not, CNN `county-races/2026-SG-{ST}.json` (LIVE, CORS `*`) is the fallback.
- **Vote-type fields exist.** `expected_vote_by_vote_type` and `eevp_by_vote_type` (advance / election day / mail / provisional) are in the raw NYT top reporting unit. They are not condensed yet. All zeros now.
- **These NYT fields are empty:** `nyt_model_estimates` (null), `partyControlTimeseriesData` (empty), `raceInsights` (empty). Don't build on them.
- **Odds history covers control markets only.** `state.history` stores only the four control odds (2 h window). There is no per-race odds history, so an odds-movers board needs a small server-side ring buffer.
- **There is already a single "next close" countdown** in the header (`tickClock`). Several ideas below grow it into something richer.

---

## The ideas

### 1. Poll-close "What to watch next" rail
A vertical timeline down the side (or a strip in theater mode), one row per closing wave: 7:00, 7:30, 8:00 … 1:00 ET. Each wave shows a live countdown and the states closing. Under that go the bellwethers and key races unlocked at that close, each with its market odds and 2024 margin. A one-line "what a good D night looks like" cue comes from the bellwether's `signal` text: for example, "VA-7: Federal workers. D needs > D+X". When a wave closes, its row turns live: mini bars fill with eevp and margin vs 2024. Past waves collapse to a summary chip ("7:00 wave: D +3.1 vs '24 across 6 races").
- **Data:** `nyt.pollClosing`, `config.races[].pollCloseET/signal`, `margin2024`, `liveMargin`, `eevp`, `/api/seats` for key (non-solid) races by state.
- **Effort:** M (3–4 h).
- **Impact:** 5.
- **Gotchas:**
  - Some states have split closes (FL panhandle, TX El Paso, KS, MI UP). NYT gives one time per state, so use the config's `pollCloseET` for bellwethers.
  - NYT gives AK/HI times past midnight UTC (`2026-11-04`), so sort by timestamp, not by string.

### 2. Race-call feed with sound ("the bong")
A ticker or feed that detects transitions between polls:
- `callStatus` changes to called
- `winnerParty` gets set
- the leader changes in a key race
- the first votes arrive in a bellwether

Each event gets a timestamped card: "8:14 PM · CALL · PA-7 · Mackenzie (R) HOLDS", with a party-color flash and a short WebAudio tone. Use different tones for a HOLD, a FLIP and a Senate call. Unmuted only after one click, because of the browser autoplay policy. Keep the last ~50 events in `localStorage` so a reload keeps the feed.
- **Data:** diff of successive `/api/seats` snapshots (`callStatus`, `winnerParty`, `leaderParty`, `inPartyControl`, `totalVotes`).
- **Effort:** S–M (2 h).
- **Impact:** 5.
- **Gotchas:**
  - NYT refreshes every 60 s, so calls arrive in batches. Stagger the animation.
  - The first diff after page load must not fire 300 events. Seed silently.
  - Watch NYT revoking a call (rare); show it as a "RETRACTED" card.
  - Optional cross-check: CNN `callsReleased` / winner flags are AP-derived and may land first (LIVE, CORS `*`, 20 s cache). That adds about 1 h.

### 3. Flip tracker board
Two columns, "D pickups" and "R pickups". Each called seat whose `winnerParty` differs from the incumbent party shows as a chip with the margin and the 2024 presidential margin. A big net number sits at the top ("Net D +4 House · needs +4 for majority"). Before calls arrive it shows "Flipping if current leads hold" in a ghost style (leaders with `inPartyControl` false relative to the leader), so it is lively from 7:30 onward.
- **Data:** `nyt.control.flipsD/flipsR` and `currentControl` for the headline number. Per-seat detail comes from `/api/seats` `winnerParty`, `leaderParty` and `inPartyControl`, plus incumbent party (candidate `incumbent` flag + `party`).
- **Effort:** S (1.5–2 h).
- **Impact:** 5.
- **Gotchas:**
  - `inPartyControl` is a boolean on the race, not a party. Get the holding party from the incumbent candidate's party, or from the winner when `inPartyControl` is true.
  - Open seats have no incumbent, so you need a mapping of party held into 2026. Fallback: NYT `flip_count` totals for the headline, and derive per-seat flips only where determinable.
  - Redistricted states (10) make "flip" fuzzy. NYT's own flip count is the authority for the headline.

### 4. "The Needle": bellwether-swing projection gauge
A semicircular needle, NYT style, with a gentle jitter. It points to the projected House seat outcome. The input is the existing generic-ballot uniform swing (vote-weighted bellwether over-performance vs 2024). Apply that swing to every House district's 2024 presidential margin (`margin2024` is in each `/api/seats` row) and count seats where 2024 margin + swing > 0. Give it a band (±1.5× the spread of bellwether swings) for the jitter range. Do the same for the Senate, using called seats plus swing-adjusted remaining races. Pair it with a "markets say" needle from Kalshi control.
- **Data:** `/api/seats.house[].margin2024`, the existing swing calculation in `index.html`, Kalshi/Polymarket control.
- **Effort:** M (3 h).
- **Impact:** 5.
- **Gotchas:**
  - Uniform swing on presidential margin overstates competitiveness. Candidate quality and incumbency matter, so label it "uniform-swing toy, not a model".
  - Early returns are skewed by vote type (mail first in some states, election day first in others). Weight by eevp and suppress the needle until three or more bellwethers have eevp > 30%.
  - Some `margin2024` values may be null for new seats. Skip them and show the count.

### 5. Odds movers leaderboard (last 30 min)
A Bloomberg-style table of the biggest Kalshi/Polymarket moves across all ~150 tracked race markets: ▲/▼ points, a sparkline, the current price, and volume. The two control markets are pinned at the top. Click a row to open the race modal. This is the board that tells you what is happening before AP calls it.
- **Data:** `/api/seats.markets` (`kD`, `pD`, `kVol`, `pVol`), snapshotted every 30 s. Add a per-race ring buffer server-side (about 15 lines in `pollExtraMarkets`; keep 2 h). Optional backfill: Kalshi candlesticks `period_interval=1` and Polymarket CLOB `prices-history?interval=1h`, both LIVE.
- **Effort:** S–M (2–2.5 h).
- **Impact:** 5.
- **Gotchas:**
  - Mid prices on thin markets jump on spread changes. Use mid only when spread < 5¢, and require minimum volume.
  - Server restarts wipe the buffer unless you persist to `cache/`.
  - CLOB needs the token id, not the slug; it is in Gamma's `clobTokenIds`.

### 6. Markets vs results "Where the money was wrong" scoreboard
As races are called, score the pre-election market against the outcome. Show a running Brier score for Kalshi vs Polymarket vs NYT rating (map ratings to probabilities: solid 97 / likely 85 / lean 65 / tossup 50). The highlight is an "Upsets" list: called races where the winner's pre-close market probability was under 30%. Freeze the pre-close price at each state's poll close, so the score isn't flattered by in-night repricing.
- **Data:** `/api/seats.markets` snapshot at `pollClosing` per state, then `winnerParty`, `rating`.
- **Effort:** M (2.5–3 h).
- **Impact:** 4.
- **Gotchas:**
  - The frozen snapshot must be persisted (`cache/` or `localStorage`), or a restart loses it.
  - Kalshi is missing for FL-14 and FL-22.
  - Rating-to-probability mapping is a judgment call. State it on screen.

### 7. County benchmark table (bellwethers)
In the race modal, and as a pop-out for the selected bellwether: each county's 2024 presidential margin and its share of expected vote. Also show the "benchmark": what margin the Democrat needs in that county to be on pace to win districtwide. Under uniform swing, the needed swing is −(district margin2024), so the county benchmark is county2024 − district2024. Live columns show the county margin, eevp, and a ✓ or ✗ chip for "ahead of / behind benchmark". The red/blue dot for each county fills with eevp. This is the "Kornacki board".
- **Data:** NYT House county `reporting_units` (`historical_comparison_race_data.pct_dem/pct_rep/margin`, `total_expected_vote`, `eevp`, live votes). Needs a one-line addition in `condenseRace` to keep `margin2024` per county. Counties are already condensed only for config bellwethers.
- **Effort:** M (2.5–3 h).
- **Impact:** 4 (5 for a politics nerd).
- **Gotchas:**
  - **Senate counties are absent from the current NYT Senate file.** Fall back to CNN `county-races/2026-SG-{ST}.json` plus the tonmcg 2024 county CSV joined on FIPS (both verified).
  - Districts split counties. The NYT county unit inside a House race is the in-district portion, which is good, but the 2024 margin is also in-district (verify on the night).
  - Benchmarks assume uniform swing.

### 8. Bellwether "crossed the line" alerts
Each bellwether gets a state machine: no votes → counting → ahead of 2024 / behind 2024. When the live margin crosses the 2024 margin, or crosses zero, and eevp > 25%, fire a toast, a soft chime and a 3-second pulse on the row and map district. Add a per-race "watch" star (keyboard `w`) so only starred races chime.
- **Data:** `liveMargin`, `margin2024`, `eevp` (already in `/api/state` races).
- **Effort:** S (1–1.5 h).
- **Impact:** 4.
- **Gotchas:**
  - Early margins swing hard on vote-type order. Add hysteresis (must stay across for two polls) and an eevp floor, or it will chime nonstop.
  - Share the AudioContext unlock with idea 2.

### 9. Trading-floor tape across the bottom
A continuously scrolling ticker:
- control odds with ▲/▼ since 7pm
- the biggest race movers
- just-called races
- the generic-ballot projection vs VoteHub average
- the Trump approval line
- the NYT counted-vote total

It uses monospace, green/red price coloring, and pauses on hover. Great on the TV-adjacent laptop because it moves even when the table doesn't.
- **Data:** everything in `/api/state` and `/api/seats`, plus the history buffer from idea 5.
- **Effort:** S (1.5 h).
- **Impact:** 4.
- **Gotchas:**
  - Respect `prefers-reduced-motion`.
  - Make it collapsible; it eats vertical space in normal layout. It fits best in theater mode's bottom strip.
  - Use a CSS animation, not JS, so it doesn't stutter during the 7 MB NYT parse.

### 10. Keyboard command palette (⌘K)
Fuzzy-search every race ("pa 7", "ossoff", "maine sen"), then Enter opens the modal. Commands cover map layer and mode ("> senate polls", "> districts live"), datasets, theater, full screen, mute, text size, and "jump to next close". Digits 1–6 switch map modes; `[` and `]` cycle bellwethers. A `?` overlay lists the keys.
- **Data:** `/api/seats` (names from candidates), `config.races`, existing UI functions.
- **Effort:** S–M (2 h).
- **Impact:** 3 (high for a power user, invisible otherwise).
- **Gotchas:**
  - `modal.js` swallows single keys while open (`stopImmediatePropagation`), so register ⌘K at capture phase.
  - Don't fire when focus is in the editable '24 or Live cells.

### 11. Shareable scorecard snapshot
A button (and the `S` key) that renders a 1200×675 card:
- seats D/R/called
- control odds
- net flips
- projected swing vs '24
- top 3 upsets
- timestamp

Render it with an offscreen canvas and copy it to the clipboard as a PNG (`navigator.clipboard.write`), ready to paste into a group chat. Optionally auto-save one every hour to build a time-lapse.
- **Data:** `nyt.control`, the control odds, the flip tracker, swing.
- **Effort:** S–M (2 h). Draw directly on canvas; no html2canvas library is needed.
- **Impact:** 3.
- **Gotchas:**
  - Clipboard image write needs a secure context. localhost counts as secure.
  - Safari requires the ClipboardItem to be built synchronously inside the click handler.
  - Fonts must be loaded before drawing.

### 12. Expected-vote "what's left" bars
For each key race, a stacked bar: counted vote by county, colored by county lean, with the remaining expected vote as a hatched ghost colored by which party's counties it sits in. The headline is "R leads by 12k, ~210k left, mostly in D-leaning counties → D favored". Show it as a mini-chart in a dedicated "Too close to call" panel listing races within 3 points and with eevp under 95%.
- **Data:** county `totalVotes`, `expectedVotes`, `eevp`, `liveMargin` plus the 2024 county margin (idea 7's server tweak). Statewide: `eevp`, `expectedVotes`.
- **Effort:** M (3 h).
- **Impact:** 4 (late night, this is the most useful view).
- **Gotchas:**
  - Counties exist only for config bellwethers (`wantCounties`). Extending this to all close races means condensing counties for every race with a margin under 5, which grows the `/api/state` payload. Gate it on closeness.
  - Expected vote is NYT's estimate and moves during the night.

### 13. Split-screen map: "Markets vs Live" and "Polls vs Live"
Two synchronized maps side by side, sharing zoom and pan:
- left: pre-election expectation (Markets, Polls or Ratings)
- right: Live

The "Live minus polls" mode already exists as one map, but side by side reads faster for a casual glance. Hovering highlights the same district on both. A variant is a "difference" toggle that outlines only the seats where the two disagree on the leader.
- **Data:** existing map modes, existing d3 and topojson code, `districts.json`, `hexmap.json`.
- **Effort:** M (3–4 h). The map code must become instance-based if it is a singleton.
- **Impact:** 3.
- **Gotchas:**
  - Rendering 435 districts twice with d3 at each refresh. Use the hex cartogram for the split view; it's cheaper and reads better small.
  - It's cramped in a narrow left column. Best only in theater mode.

### 14. Cartogram "fill-in" race-call animation plus a seat-count race bar
On each call, the hex for that seat pulses and fills. A tug-of-war bar at the top animates toward 218, with ghost segments for leaders and a vertical majority line that glows when one party crosses it. The "magic number" text reads "D needs 31 of 112 remaining", computed from uncalled seats.
- **Data:** `/api/seats` calls, `nyt.control.toWin`, `hexmap.json`.
- **Effort:** S (1.5 h), because the hex cartogram and seat bars exist.
- **Impact:** 4.
- **Gotchas:**
  - Batch calls (up to 20 at a 60 s poll) need a staggered queue so the animations don't all fire in one frame.
  - The "remaining needed" count must exclude uncontested races that are already called.

### 15. Vote-type "mirage meter"
Per key race, show what share of counted vote is mail/advance vs election day, against the expected share by type. The live margin gets a "likely to shift D / R" arrow when one type is over-represented. NC is the showcase: NC SBE splits early, election-day, absentee and provisional votes and is set up for 2026.
- **Data:** NYT `expected_vote_by_vote_type` and `eevp_by_vote_type` (present in the raw feed, not condensed yet). NC SBE `results_0.txt` (LIVE, proxy needed).
- **Effort:** M (3 h; 1.5 h NYT-only).
- **Impact:** 3.
- **Gotchas:**
  - The vote-type split is all zeros now, so we don't know how richly NYT will populate it.
  - The direction of the bias (which type leans which way) varies by state. Infer it from the live by-type margins, if NYT gives candidate votes by type (unverified), else NC-only.

### 16. "Spending vs result" bang-for-buck board
After calls, rank races by dollars per vote and by "most expensive loss": total spend from `/api/spending.districts` (and Senate states), and which side outspent, vs the outcome. Headlines like "Biggest outspend that lost: R +$41M in ME-Sen". Pair it with the top-spender PACs (`topSpenders`): each super PAC's record tonight (W-L of the races it spent in).
- **Data:** `/api/spending` (`districts`, `states`, `topCandidates`, `topSpenders`) plus calls.
- **Effort:** S–M (2 h for the race ranking).
- **Impact:** 3.
- **Gotchas:**
  - `topSpenders` is aggregated nationally, without a per-race breakdown in the current payload. A PAC win-loss record needs `spending.js` to keep the spender → race map from the IE CSV (another 1–2 h).
  - Only federal races have FEC data; governor races are excluded.

### 17. Context sidebar: national environment card
A compact card that answers "is this a wave?":
- the VoteHub generic ballot (D+7.4) vs the live bellwether-implied national margin
- Trump net approval (−19.3)
- an "implied environment" thermometer
- the 2018 benchmark (D+8.6) as a reference line, a historical constant to hard-code

At the bottom sits a fun extra: the 2028 primary poll leaders, with chips lighting up for 2028 names who are on tonight's ballot (Ossoff is at 6.4% and is up in GA).
- **Data:** `polls.genericBallot`, `trumpApproval`, `primary2028`, the existing swing projection, `/api/seats` candidate names.
- **Effort:** S (1–1.5 h).
- **Impact:** 3.
- **Gotchas:**
  - The 2028-name matching is by string. Normalize "Alexandria Ocasio Cortez" vs "Ocasio-Cortez".
  - `n: 1` primary polls are thin, so label it.

### 18. "Since you looked away" catch-up digest
When the tab regains visibility or focus after more than 3 minutes (Page Visibility API), slide in a digest:
- calls made since the last view
- control odds change
- biggest race mover
- new flips
- polls that closed

Dismiss with any key. It suits a viewer watching TV who glances at the laptop occasionally.
- **Data:** the event log from idea 2, plus the history buffer.
- **Effort:** S (1 h, given idea 2).
- **Impact:** 4.
- **Gotchas:**
  - Only works if idea 2's diff engine runs while the tab is hidden. It does: timers are throttled to 1/min in background tabs, which is fine for a 30–60 s poll.

### 19. Source-race badge: NYT vs CNN/AP "who's faster"
For each key race, a small badge shows which feed has more votes and calls first. CNN's AP-derived national-races files are CORS `*` with a 20 s cache, vs NYT's 60 s polling of a 7 MB file. It fills the race with the fresher count and shows a "CNN +3 min" lead counter. This is effectively a faster results feed with a fun scoreboard on top.
- **Data:** CNN `politics.api.cnn.io/results/national-races/2026-{SG,HG,GG}.json` (LIVE-2026, 885 KB House).
- **Effort:** M (3 h). Needs id mapping: CNN race to state and district.
- **Impact:** 3 (4 if NYT lags tonight).
- **Gotchas:**
  - Two sources can disagree on calls (AP vs NYT both use AP, but timing differs). Never merge calls; show both.
  - CNN's field names are verified only pre-election.

---

## Top 7 for tonight (impact per hour)

| Rank | Idea | Effort | Impact | Why now |
|---|---|---|---|---|
| 1 | **#2 Race-call feed with sound** | ~2 h | 5 | It's the heartbeat of the night, and its diff engine powers #3, #8, #14 and #18. Build it first. |
| 2 | **#3 Flip tracker** | ~1.5–2 h | 5 | `flipsD/flipsR` and `currentControl` are already in `nyt.control`. The headline number is nearly free; the per-seat chips reuse #2's diffs. |
| 3 | **#14 Cartogram fill-in plus magic number** | ~1.5 h | 4 | The hex cartogram and seat bars exist. Animation plus "D needs X of Y remaining" is a big payoff for little code. |
| 4 | **#5 Odds movers leaderboard** | ~2–2.5 h | 5 | The markets move before calls. Needs only a per-race ring buffer added to `pollExtraMarkets`. |
| 5 | **#8 Bellwether crossed-the-line alerts** | ~1–1.5 h | 4 | All inputs are in `/api/state`. Shares the audio unlock with #2. |
| 6 | **#1 Poll-close "what to watch next" rail** | ~3–4 h | 5 | Highest-value early-evening (7–9pm) view. It grows the existing `#nextclose` countdown. Ship a simple version (waves, countdown, bellwether rows) first. |
| 7 | **#18 "Since you looked away" digest** | ~1 h | 4 | Near-free once #2 exists, and matches the TV-plus-laptop setup. |

**Next if there's time:** #4 (needle, 3 h, very fun but it needs eevp guarding), #7 plus #12 (county benchmarks and "what's left"; start with the one-line `condenseRace` change to keep county `margin2024`), and #9 (tape, 1.5 h).

**Suggested build order for a ~10 h budget:** #2 → #3 → #8 → #14 → #18 → #5 → #1. That sequence ships something visible every 1–2 hours. The shared pieces (the diff/event engine and the AudioContext unlock) are built once, up front.
