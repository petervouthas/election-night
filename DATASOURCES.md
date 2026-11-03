# Election-night data sources: live verification (probed 2026-11-02, ~10pm ET / 03:05Z Nov 3)

Every probe used `curl -s -L -m 20 -A "Mozilla/5.0"`. Latency is total_time from one run on a home connection.
Status key: **LIVE-2026** means it returned real 2026 general-election data. **LIVE** means it responds but has no 2026 results. **BLOCKED** means it returned 403, 429 or a bot challenge. **DEAD** means 404 or a wrong pattern.

## 1. Live results feeds

### CNN results API: LIVE-2026, the best find
- National races: `https://politics.api.cnn.io/results/national-races/2026-{SG|HG|GG}.json`
  - SG = Senate general, 35 races, 84 KB, 0.24 s
  - HG = House general, 436 races, 885 KB, 0.64 s
  - GG = Governor general, 36 races, 88 KB, 0.23 s
- County level: `https://politics.api.cnn.io/results/county-races/2026-{SG|GG}-{ST}.json`. Example: `2026-SG-GA.json` returned 159 GA counties with `countyFipsCode`, 183 KB, 1.2 s.
- House counties: `county-races/2026-HG-{ST}-{district}.json`. `2026-HG-PA-7.json` returned 200 with 4.7 KB.
- Auth: none. Format: JSON array of races.
- Fields per race: `candidates[] {fullName, candidatePartyCode, isIncumbent, voteNum, votePercentNum, winner}`, `percentReporting`, `totalVote`, `status`, `raceToWatch`, `extractedAt`.
- Each race also has a `raceEmbargo` object with `pollsOpen`, `assignedPollsClose`, `votesRelease`, `callsRelease` and `exitPollsRelease` as epoch ms, plus flags such as `callsReleased` and `pollsClosed`. That makes it a ready-made **poll-closing-time dataset** and a **race-call feed**.
- Headers: `cache-control: max-age=20` and `access-control-allow-origin: *`, so it can be fetched straight from the browser. It sits behind CloudFront. `extractedAt` showed `2026-11-02T20:25`, so the pipeline is running.
- CNN's results are AP-derived (`cid: "ESS::Race::..."`), so this is effectively a free AP mirror and a good cross-check against NYT.
- Patterns that returned 404: `2026-H.json`, `2026-G.json`, `county-races/2026-SG-13.json` (FIPS instead of the state code), `bop/`, `key-races/`, `state-races/`, `national-races/2026-BM.json`.
- Exit polls: the `exit-polls/...` guesses returned 404. `exit-polls/national-results/2026-HG.json` returned 403 with JSON, which suggests the path exists but is embargoed until polls close. Retry on Nov 3 after 5pm ET.

### North Carolina SBE ENR: LIVE-2026, set up and showing zeros
- Statewide contests: `https://er.ncsbe.gov/enr/20261103/data/results_0.txt`. It is JSON despite the .txt extension: 660 contest-candidate rows, including `US SENATE` (Cooper and others). 182 KB, 0.49 s.
- Per county: `results_{countyId}.txt`, county ids 1 to 100. Example: `results_1.txt` is Alamance.
- County metadata and precinct reporting: `https://er.ncsbe.gov/enr/20261103/data/county.txt`. It has `prt/ptl` precincts reporting (0/2626), `rtl` registered voters (7,885,046) and an `imp` timestamp ("November 2, 2026 4:48 pm").
- Field codes: `vct` votes, `pct` percent, `evc/ovc/avc/pvc` vote counts by type (early, election day, absentee, provisional), `pty` party.
- Precinct bulk file: `https://s3.amazonaws.com/dl.ncsbe.gov/ENRS/2026_11_03/results_pct_20261103.zip` (637 KB, a 14.6 MB txt).
- CORS: er.ncsbe.gov sends no ACAO header, so fetch it server-side. The S3 files send `Access-Control-Allow-Origin: *`.

### Minnesota SOS media files: LIVE-2026
- `https://electionresultsfiles.sos.mn.gov/20261103/ussenate.txt` (329 B; Flanagan, Tafoya and others, all 0) and `.../ushouse.txt`.
- Format: semicolon-delimited text, 0.2 to 0.3 s.
- `stgov.txt` returned 404. Minnesota does have a governor race in 2026, so that file must use a different name. Check the index at `https://electionresultsfiles.sos.mn.gov/20261103/`.

### NYT
- Only `results-{house,senate,governor}.json` exist, and those are already integrated.
- 404 (a 29 KB NYT error page): `exit-polls.json`, `exit-polls-{national,house,senate}.json`, `needle-house.json`, `balance-of-power.json`, `results-ballot-measures.json`, `results-mayor.json`, `results-state-senate.json`, `results-attorney-general.json`, `poll-closing-times.json`, `forecast-house.json`.
- The 2024 `exit-polls-president.json` also returned 404, so NYT does not use that naming. No NYT exit-poll file was found.

### Other state and media feeds
| Source | Result |
|---|---|
| PA electionreturns.pa.gov | Home 200. `/api/ElectionReturn/GetCountyBreak?...&electiontype=G&isactive=1` returned `[]` (empty, not live yet). `GetElectionsList` returned 404. Likely to come alive on election night; needs the active election id. |
| VA results.elections.virginia.gov | Home 200 (38 KB). The `2026 November General/Json/...` and `/Site/...` guesses returned 404. The folder name is unknown; look it up from the home page on the night. |
| GA results.sos.ga.gov | 200, but it is an Angular SPA. `/cdn/results/Georgia/...` guesses returned BlobNotFound. Old Clarity `results.enr.clarityelections.com/GA/` returned 403. Needs DevTools to find the Azure blob path. |
| OH liveresults.ohiosos.gov | Page 200 (68 KB). `/Api/v1/download?filename=summary.json` returned 500. |
| IN enr.indianavoters.in.gov | 200, Angular app. The `jsonDataFetcher.js` path returned an Azure error; the JSON path needs inspection. |
| FL results.elections.myflorida.com | 200 (2 KB). `downloadresults.asp` returned 500; flelectionwatch had a connection failure. |
| MI | mvic returned 403; mielections.us timed out. |
| TX | results.texas-election.com returned 403; goelect.txelections.org had a connection failure. |
| NY, WI, AZ | All 403 (Cloudflare/Akamai) for curl. |
| Politico, Reuters, Economist, Cook, Inside Elections | 403 (bot wall). |
| WaPo | Connection refused for curl. |
| DDHQ | `results.decisiondeskhq.com` and `votes.decisiondeskhq.com` returned 429 (rate-limited or bot wall); `embed-api.ddhq.io` returned 404. |
| NBC | Guessed URL returned 404. |
| ABC, Fox | HTML 200, with no JSON endpoint found. |
| AP | `api.ap.org/v3/elections` returned 403 and needs a paid key. |
| Google Civic | 403 without a key. Its `/elections` endpoint needs a key, and Google retired the representatives endpoint in 2025. Low value. |

## 2. Early vote and turnout

### UF Election Lab (Michael McDonald): LIVE-2026, excellent
- `https://election.lab.ufl.edu/data-downloads/earlyvote/2026/US.csv` (200, 23 KB, 0.28 s). Found via `wp-content/themes/electionlab2023/2026-early-voting.js`.
- One row per state, 49 states.
- Columns: `turn_2022`, `last_update`, `data_source`, plus `request_*`, `accept_*`, `inperson_*` and `voted_*`, each split by party, age bucket, race and gender. `updates_today` is also included.
- Example: AZ `voted_all=1,648,197` (D 613k / R 625k), updated 11/2/2026.
- Use it for an "early vote as % of 2022 turnout" overlay and party-registration splits.
- Per-state CSVs (`GA.csv`, `NC.csv`) returned 404; only US.csv exists.
- No CORS header, so proxy it.

### NC SBE absentee files: LIVE-2026
- `https://s3.amazonaws.com/dl.ncsbe.gov/ENRS/2026_11_03/absentee_counts_state_20261103.csv` (204 KB). Its count column sums to **2,819,921** ballots.
- Same counts split by county: `absentee_counts_county_20261103.csv` (22.9 MB).
- The count column header is literally `0`. That is a quirk; treat it as the count.
- Full voter-level file: `absentee_20261103.zip` (123 MB, 9.4 s). Too heavy for a live overlay.
- CORS `*`.

### Other turnout trackers
- **TargetEarly / TargetSmart:** 403 (Cloudflare), no public API.
- **GA SOS turnout hub:** 403.

## 3. Exit polls and demographics
- **NYT exit-poll JSON:** none found (see the 404 list above).
- **CNN exit polls:** path likely exists but is embargoed (403). Each race's `raceEmbargo.exitPollsRelease` field gives the release time.
- **Census ACS API:** `api.census.gov/data/2023/acs/acs5?...` now returns a "Missing Key" HTML page (200 status, HTML body) **without a key**. A free key is required (instant signup at api.census.gov/data/key_signup.html). Plan: pre-fetch once, server-side, and cache a county table with Hispanic share (B03003), education (B15003) and median age (B01002). The metadata at `api.census.gov/data.json` loads without a key.

## 4. Race ratings
- **Wikipedia Predictions tables: LIVE, the best free aggregator.**
  - URL: `https://en.wikipedia.org/w/api.php?action=parse&page=2026_United_States_Senate_elections&prop=wikitext&section=10&format=json` (200, 36 KB, 1.5 s).
  - Columns: Cook, DDHQ, Economist, FiftyPlusOne, Fox, and others; 12 rating columns, updated "Nov 2, 2026".
  - Parse the `{{USRaceRating}}`-style cells. The House page has the same "Predictions" section.
  - Find the section index with `prop=sections`; it was 10 for the Senate page.
  - CORS works with `&origin=*`.
- **270toWin:** `https://www.270towin.com/2026-senate-election/` returned 200 (447 KB HTML). It has a consensus map that can be scraped. The `/content/2026-senate-ratings-map` guess returned 404.
- **Race to the WH:** `https://www.racetothewh.com/senate/26` returned 200 (244 KB HTML). No CSV or JSON link was found in the HTML; the data is likely embedded in JS or a Google Sheet.
- **Split Ticket:** home page 200; guessed ratings pages returned 404.
- **Silver Bulletin:** home page 200 (HTML).
- **FiftyPlusOne:** 200 (3 KB, an SPA shell).
- **Cook, Sabato, Inside Elections, Economist:** 403. **Ballotpedia:** 202 (bot challenge).

## 5. Prediction market extras
- **Kalshi candlesticks: LIVE.**
  - URL: `https://api.elections.kalshi.com/trade-api/v2/series/CONTROLH/markets/CONTROLH-2026-D/candlesticks?start_ts=1761000000&end_ts=1793600000&period_interval=1440`
  - Returned 378 daily candles, 173 KB, 0.29 s. Each has `price.{open,high,low,close,mean}_dollars`, `yes_bid`, `yes_ask`, `volume_fp` and `open_interest_fp`. The latest close was 0.937 (D House).
  - `period_interval` can be 1, 60 or 1440 minutes.
  - Trade tape: `/trade-api/v2/markets/trades?ticker=CONTROLH-2026-D&limit=3` (200, real-time trades with timestamps). Use it for a "last trade" ticker.
  - One header test sent with an `Origin` header got "Error from cloudfront", so call it server-side.
- **Polymarket CLOB price history: LIVE.**
  - URL: `https://clob.polymarket.com/prices-history?market={clobTokenId}&interval=1w&fidelity=60` returns `{history:[{t,p}]}` (4 KB, 0.13 s, CORS `*`, max-age 90).
  - `interval` takes `1h`, `6h`, `1d`, `1w`, `1m` or `max`. `market` must be the **token id** from Gamma's `clobTokenIds`, not the market id; `market=0` returns an empty history.
  - Order book: `https://clob.polymarket.com/book?token_id=...` (200).
  - Trades: `data-api.polymarket.com/trades` returned 410 (gone).
- **PredictIt: LIVE.**
  - All markets: `https://www.predictit.org/api/marketdata/all/` (200, 537 KB, 0.54 s). It has 239 markets, including House/Senate control, House seat counts, and Senate races for GA, MI, ME, NC, NH and MN.
  - Single market: `/api/marketdata/markets/{id}` (7 KB).
  - No ACAO header, so proxy it. PredictIt's API is documented as updating about every 60 s.
- **Manifold: LIVE.**
  - URL: `https://api.manifold.markets/v0/search-markets?term=2026%20senate&limit=5` (200, 0.63 s).
  - Example: "Will Republicans win the Senate in 2026?" at p=0.204.
  - Play money. CORS is open.
- **Metaculus:** 403 on both api2 and the newer api. It now requires a token.

## 6. Social and attention signals
- **Wikipedia pageviews: LIVE.**
  - URL: `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/{Article}/daily/{YYYYMMDD}/{YYYYMMDD}` (200, 0.28 s). Example: the 2026 Senate elections article had 20.9k views on 10/20, rising toward Nov 1.
  - Granularity is **daily or monthly only** (an hourly request returned 400). There is about a 1-day lag, so it does not update live on election night. Good for a "most-searched candidates this week" panel.
  - Top-articles list: `.../pageviews/top/en.wikipedia/all-access/2026/11/01` (200).
  - Send a descriptive User-Agent.
- **Bluesky:** search is LIVE via `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=midterms&limit=3` (200, CORS `*`, real midterm posts).
  - Note that `public.api.bsky.app/...searchPosts` returned **403**, while `public.api.bsky.app/...getProfile` works.
  - A firehose or Jetstream websocket (wss://jetstream2.us-east.bsky.network) would give a live keyword-volume meter. Not probed.
- **Mastodon:** `https://mastodon.social/api/v1/timelines/tag/midterms?limit=3` returned 200 with no auth.
- **Google Trends:** the old `/trends/api/dailytrends` returned 404. **`https://trends.google.com/trending/rss?geo=US` is LIVE** (200 RSS, includes `ht:approx_traffic`). It lists only the nationwide trending searches; there is no per-keyword series without the unofficial pytrends scraping.
- **Reddit:** `.json` returned 403 for both www and old. It now needs OAuth (a free app token).
- **YouTube Data API:** 403 without a key. A free key is needed for `liveStreamingDetails.concurrentViewers`; quota is 10k units/day, and videos.list costs 1 unit. Channel RSS (`youtube.com/feeds/videos.xml?channel_id=`) is LIVE without a key but has no viewer counts.
- **Twitch Helix:** 401. It needs a client-id plus an app token (free).
- **GDELT doc API:** 429 (rate-limited at probe time). It is normally free and gives a news-volume timeline (`mode=timelinevol`).
- **Hacker News Firebase:** 200 (not election-relevant).

## 7. Weather (NWS): LIVE, no key, CORS `*`
- Alerts for swing states: `https://api.weather.gov/alerts/active?status=actual&message_type=alert&area=GA,PA,MI,NC,AZ,WI` (200, 26 KB, 0.40 s). It returned 4 Flood Warnings at probe time.
- National counts by state: `https://api.weather.gov/alerts/active/count` (200, max-age 5 s).
- Forecasts: `https://api.weather.gov/points/{lat},{lon}`, then follow `properties.forecast`. Example: `https://api.weather.gov/gridpoints/PHI/50,76/forecast` (200, 13.5 KB).
- NWS requires a User-Agent; a generic one worked.
- Overlay value: low to moderate. Use it as a "severe-weather alerts in counties with close races" badge, to explain slow counting or turnout dips. Join on the alert's `geocode.SAME` FIPS codes against county FIPS.

## 8. Other useful sources
- **OpenFEC API:** `api_key=DEMO_KEY` works.
  - `https://api.open.fec.gov/v1/candidates/?api_key=DEMO_KEY&election_year=2026&office=S&per_page=3` (200, 0.69 s).
  - `/v1/schedules/schedule_e/?api_key=DEMO_KEY&cycle=2026&sort=-expenditure_date` (200, 5.8 s, 69k IE rows). Some `expenditure_date` values are garbage (2029-10-01), so filter them out.
  - DEMO_KEY is heavily throttled. A free api.data.gov key allows 1,000 req/hr (more on request).
  - Adds near-real-time 24/48-hour IE reports versus the bulk CSV.
- **Congress.gov API:** `https://api.congress.gov/v3/member?api_key=DEMO_KEY` (200). Use it for incumbents and Senate holdovers.
- **tonmcg county presidential results:**
  - `https://raw.githubusercontent.com/tonmcg/US_County_Level_Election_Results_08-24/master/2024_US_County_Level_Presidential_Results.csv` (200, 352 KB, 0.50 s; the 2020 file is also 200).
  - County FIPS-keyed, CORS-friendly through raw.githubusercontent.
  - Use for "2026 county margin vs 2024 Trump margin" swing overlays at county level, joined to CNN or NYT county FIPS.
- **MIT Election Lab:** Harvard Dataverse API, `https://dataverse.harvard.edu/api/datasets/:persistentId/?persistentId=doi:10.7910/DVN/VOQCHQ` (200). Gives county presidential returns 2000–2024 for a historical baseline. Download once.
- **OpenSecrets API:** discontinued in 2025; the page returned HTML, not data. Skip it.
- **Open States:** 403 without a key.
- **unitedstates.io legislators JSON:** connection failure. Use GitHub raw (`unitedstates/congress-legislators`) instead.
- **Dave's Redistricting:** 200 (SPA). District-level demographics are not easily scrapeable.

---

## Top 10 to integrate next (ranked)

1. **CNN results API** (`politics.api.cnn.io/results/national-races/2026-{SG,HG,GG}.json` plus `county-races/2026-{SG,GG}-{ST}.json`). No key, CORS `*`, 20 s cache, and 2026 already set up with all 436 House, 35 Senate and 36 Governor races. It is an independent AP-derived feed to cross-check NYT and catch whichever updates first.
2. **CNN `raceEmbargo` timestamps** (same files). Exact per-race poll-open, poll-close, vote-release and call-release times, plus `callsReleased` and `pollsClosed` flags. Use them for a poll-closing countdown and a "just called" ticker with no extra source.
3. **UF Election Lab early-vote US.csv.** No key and live as of Nov 2. Gives early vote by party, age and race for 49 states, plus 2022 turnout as the denominator. Use it for an early-vote share of expected turnout overlay.
4. **Kalshi candlesticks and trades.** History for Kalshi is already being polled, but these endpoints add verified daily and hourly OHLC and a trade tape. Use them for sparklines and an "odds swing tonight" chart.
5. **Polymarket CLOB `prices-history`.** CORS `*`; returns time series per token. Pair it with Kalshi for a dual-line odds chart.
6. **NC SBE ENR** (`er.ncsbe.gov/enr/20261103/data/results_0.txt` and `county.txt`). Set up for 2026 and fast (CloudFront). It splits votes into early, election-day, absentee and provisional, which reveals the "red mirage / blue shift" in the NC Senate race (Cooper). It also has precinct reporting counts. Use it as a source for the closest, earliest-closing marquee Senate race (polls close 7:30pm ET).
7. **Wikipedia Predictions tables** (Senate and House pages via the `action=parse` wikitext API). The only machine-readable, no-key aggregate of 12 raters (Cook, DDHQ, Economist, FPO, Fox and others), updated Nov 2. Use for a "pre-election consensus vs result" overlay. Parse once.
8. **PredictIt all-markets JSON.** No key, with 239 markets including state Senate races and seat-count brackets. It is a third market to compare. Proxy it (no CORS).
9. **tonmcg 2024 county results CSV, joined by FIPS** to CNN or NYT county reporting. Enables county-level swing-vs-2024 for bellwether counties. Add Census ACS with a free key once, cached, for Hispanic, college and age tags.
10. **NWS alerts count and area alerts.** No key, CORS `*`, 5 s cache. A cheap "weather disruption" badge for counties in swing states. Runners-up:
    - Minnesota SOS text files (2026 live)
    - Bluesky `api.bsky.app` searchPosts as a chatter meter
    - Manifold markets
    - FEC Schedule E with a free api.data.gov key

### Gotchas summary
- Most state SoS sites and major media (Politico, WaPo, Reuters, Cook, Sabato, TargetEarly, DDHQ) block curl with Cloudflare or Akamai, returning 403 or 429. Don't build on them without a headless browser.
- PA returns `[]` and VA/GA/IN/OH paths are unresolved; recheck on the night of Nov 3, when the active election ids appear.
- These do not send CORS headers and need a local proxy: er.ncsbe.gov, election.lab.ufl.edu, predictit.org, MN SOS, Kalshi.
- These send CORS `*`: CNN, Polymarket CLOB, NWS, Bluesky, NC S3.
- Census ACS now requires a key (it returns a "Missing Key" HTML page with status 200, so check the body, not the status code).
- Wikipedia pageviews are daily only, with about a 1-day lag.
- Metaculus, Reddit, YouTube and Twitch require auth.
