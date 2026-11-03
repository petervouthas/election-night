# Live-night quantitative analytics: evaluation (read-only brainstorm)

Notation used throughout. Margins are D minus R in points of total vote. For a race i: E_i is the expected total vote (`total_expected_vote`), V_i the votes counted, e_i = eevp/100, m_i the live margin, b_i the 2024 presidential margin. A *unit* j is a county-in-district reporting unit with the same fields.

## 0. What I checked in the live data (it changes some of the candidate ideas)

- **County-in-district 2024 benchmarks already exist for House races, drawn on the new lines.** The raw NYT House file has 3,737 county-level `reporting_units` across 434 of 436 races, and 3,590 of them carry `historical_comparison_race_data["ST-G-P-2024-11-05"].margin`. Counties that are split between districts carry a different margin for each piece, so these are district-portion numbers. For example, Jefferson County AL is R+16.2 in AL-6 and D+36.3 in AL-7. Mid-decade redistricting is therefore mostly handled already, down to the county-piece level. `server.js` `condenseRace` throws this away: it keeps counties only for the 15 config races and drops their 2024 margin. Keeping them is a small server change, and it is a prerequisite for ideas 1 and 2.
- **NYT has a national House popular-vote race**, `US-G-H-2026-11-03` (`level: national`), with `total_expected_vote` = 120,711,369 and D/R/other totals. The server currently filters it out (`!r.nyt_id.startsWith('US-')`).
- **The Senate file has no county units right now.** Each of the 35 races has only its state unit, so the county model cannot run for Senate from NYT today. It may populate tonight, but that is unverified. The fallback is CNN `county-races/2026-SG-{ST}.json` (verified, FIPS-keyed, with `percentReporting` rather than eevp) joined to the tonmcg 2024 county CSV (verified).
- **Every unit has `eevp_by_vote_type` / `expected_vote_by_vote_type`** (advance, absentee_mail, advance_in_person, election_day_in_person, provisional). Today they are all 0 except the total. If AP fills them tonight, they directly address the early-vs-Election-Day skew (see idea 2).
- **Every unit and candidate has a `nyt_model_estimates` field (null now), and each race has `model_settings`.** If NYT populates these tonight, that is NYT's own needle estimate for free. Before building anything heavy, spend 5 minutes at 7:30pm checking whether they are non-null.
- **Market coverage**: 116 markets (35 Senate plus 81 non-solid House). 78 have both sources, 2 are Kalshi-only and 36 Polymarket-only. The median Kalshi-Polymarket gap is 0.55 pt and the maximum is 9.5 pt. The in-memory `history` holds **control odds only** (kH, pH, kS, pS over 2 h). There is no per-race history.
- **18 House races have no D-vs-R matchup** (CA and WA top-two, plus FL-10, MA-1/2/5/7, NJ-8, PA-3, WI-2). They hold about 2.9M of the 119.5M expected district vote.
- **VoteHub averages** cover the generic ballot (D+7.4, n=5) plus 23 Senate, 31 governor and 70 House races.
- **The existing generic-ballot projection is biased.** It weights each bellwether's swing by raw `totalVotes` counted so far, so a county that dumps its mail ballots first dominates early in the night. The fix is described under idea 1.

---

## 1. National "needle": projected House popular-vote margin. **Keep (as a district-sum model).** Effort M, value 5

Bellwether-only uniform swing (what exists today) has 15 races, mostly in the East, and is biased by count order. Using every district is better, and the data supports it.

**Math**
1. For each contested district i that has votes, compute the projected final margin M_i from idea 2 (or the cheap version, M_i = (V_i·m_i + (E_i−V_i)·(b_i+ŝ_i))/E_i). Its swing is s_i = M_i − b_i.
2. **National swing, with partial pooling toward a poll prior.**
   - Prior: s₀ = GB_poll − (−1.5) = 7.4 + 1.5 = +8.9, with σ₀ ≈ 3.5. That is roughly the historical generic-ballot polling error. −1.5 is the 2024 presidential national margin; keep the baseline as presidential, because b_i is presidential.
   - Data estimate: ŝ_data = Σ wᵢ sᵢ / Σ wᵢ, with wᵢ = E_i · min(1, e_i/0.5). Districts under 50% eevp are down-weighted, which damps count-order bias.
   - The standard error must be **clustered by state**, since count order and state political effects are shared: SE² = Σ_states (Σ_{i∈state} wᵢ(sᵢ−ŝ))² / (Σw)², floored at (5 pt)²/n_states_reporting.
   - Posterior: ŝ = (s₀/σ₀² + ŝ_data/SE²)/(1/σ₀² + 1/SE²), with σ_post = (1/σ₀² + 1/SE²)^−½.
3. **Districts with no votes yet**: M_i = b_i + ŝ_state(i) if the state has data (same shrinkage toward ŝ), otherwise b_i + ŝ.
4. **National margin**: N = Σ_{contested} E_i M_i / Σ E_i. Show N ± 1.64·σ_post (a 90% band). Also show the raw counted national margin from `US-G-H` for contrast. The gap between them is the "count-order mirage".
5. Report two numbers:
   - "Generic-ballot equivalent" = −1.5 + ŝ. This is comparable to the VoteHub generic ballot.
   - "Projected House popular vote" = N. This includes incumbency effects and the turnout mix.

**Failure modes**
- Early in the night only IN, KY, FL, GA and VA report. FL is shifting R and VA counts its central absentee batches late, so the shrinkage to the prior must dominate until about 15 states report. That is why the prior is included.
- Incumbency and candidate quality add about 5 pt of district-level noise around a uniform swing. Clustering handles some of it, not all.
- Uncontested and same-party races are excluded from the numerator and the denominator. If the needle is shown as "popular vote", say "contested seats". AP's US-national total includes those races.
- AP's E is revised during the night (±5–10%). Recompute every tick and never cache E.
- Turnout differential: a D-favourable environment with low turnout in R seats is captured only through E. That is acceptable.

---

## 2. Per-race county benchmark projection (DDHQ/NYT-needle style). **Keep, top priority.** Effort M, value 5

**Math** (race i, units j):
1. For counted units with e_j ≥ 0.2, the unit swing is s_j = m_j − b_j.
2. **Race swing estimate**: ŝ_i = Σ w_j s_j / Σ w_j, with w_j = V_j · min(1, e_j/0.6). Shrink it toward the national ŝ from idea 1: ŝ_i ← (n_eff·ŝ_i + k·ŝ_nat)/(n_eff + k), with k ≈ 1 and n_eff = (Σw)²/Σw². With no counted units, ŝ_i = ŝ_state, falling back to ŝ_nat.
3. **Projected unit margin**: M_j = [V_j·m_j + (E_j − V_j)·(b_j + ŝ_i)] / E_j. Units with e_j ≥ 0.95 keep m_j. If E_j < V_j (AP under-estimated turnout), set E_j = V_j/e_j.
4. **Race projection**: M_i = Σ_j E_j M_j / Σ_j E_j. Use `total_expected_vote` from the unit, not the race, so the sum matches.
5. **Uncertainty**:
   - τ² is the V-weighted variance of s_j across counted units, floored at (4 pt)².
   - The race-swing variance is σ_ŝ² = τ²/n_eff + σ_order², where σ_order = 3 pt × (1 − e_i) is a count-order term that fades as the count completes.
   - f_i = Σ(E_j−V_j)/ΣE_j is the outstanding share.
   - Var(M_i) ≈ f_i²·σ_ŝ² + Σ_j ((E_j−V_j)/E_i)²·τ² + (0.05·f_i·|M_i|)². The last term is for expected-vote error.
   - P(D) = Φ(M_i / √Var).
6. **Display**: "Proj D+2.1 (±3.4), P(D)=73%". Put it next to Kalshi and Polymarket in the table. **Flag a race when |P(D) − market| > 20 pt and f_i < 0.5.** That is the actionable signal.

**Inputs**: all present in the NYT House feed once the server keeps unit-level `historical_comparison_race_data` and `total_expected_vote` for all races. That is 3.7k units × ~6 numbers, so serve it from a separate `/api/units` endpoint or diff it.

**Failure modes**
- **Count order within a county.** This is the big one.
  - PA counts mail in some counties first and in others last.
  - VA reports central absentee precincts late, often D.
  - NC, FL and GA put early votes in the first drop.
  - AZ late-earlies lean R.
  - CA and NV are mail-heavy and slow.

  The e_j/0.6 down-weighting plus σ_order are the generic guard. If AP fills `eevp_by_vote_type`, do better by splitting each unit into a counted-by-type and an expected-by-type part, and estimating swing only from type-matched comparisons. That needs a "mail swing" vs "ED swing" learned across units in the same state, so it costs 2× the effort. A cheap additional guard is a config table `{ST: 'early-first' | 'ed-first' | 'mixed'}` that shows a "blue shift" or "red shift" risk badge without modelling it.
- **Partial counties**: handled by projecting each unit's own remaining vote. Do not drop them.
- **Uncontested and same-party races**: skip; no projection.
- **147 units have no 2024 margin**: fall back to race-level b_i for that unit.
- **Redistricting**: mostly solved, because the per-piece benchmarks are already on the new lines (verified). The residual problem is that 2024 presidential results are not 2026 House results (incumbency, candidate effects). Shrinkage toward the national swing handles this partly.
- **Senate**: no NYT counties today. Use the CNN county feed plus the tonmcg 2024 county CSV, keyed by FIPS. Approximate eevp ≈ `percentReporting`, which counts precincts, not votes, and is worse.
- **One-county districts** (e.g., FL-14 has 1 unit): the model degrades to "live margin + benchmark for the remainder", and ŝ_i comes almost entirely from the state or national swing. Show a lower-confidence badge.

---

## 3. Implied House seats from race markets vs the control market. **Keep, with an implied-correlation framing.** Effort S–M, value 4

**I ran this on live data just now.** I filled in market p (Kalshi/Polymarket average) for the 81 non-solid seats and mapped ratings to probabilities for solid seats (0.99/0.01). The expected D seat count is Σp = **242.6**. Under independence the SD is 4.1, so P(D ≥ 218) ≈ 1.000, against a control market of 93.6% (Kalshi) and 94.5% (Polymarket). Raw independence is useless. The right construction is a **one-factor correlation model**:

- Race i goes D iff Φ⁻¹(p_i) + √ρ·X + √(1−ρ)·ε_i > 0, with X and ε_i ~ N(0,1). The marginals stay equal to p_i.
- P(control | ρ) = ∫φ(x) · PoissonBinomial_{≥218}(qᵢ(x)) dx, where qᵢ(x) = Φ((Φ⁻¹(pᵢ) + √ρ·x)/√(1−ρ)).
- Compute it with about 40 quadrature nodes × a 435-term DP, which is about 4M operations. That is fine in the browser.
- Results on the live data, ρ → P: 0 → 1.00, 0.1 → 0.98, **0.2 → 0.95**, 0.3 → 0.92, 0.4 → 0.90, 0.6 → 0.88.
- So the control market's **implied correlation is ρ ≈ 0.2**. Solve for it by bisection each tick.

**Display**: "Race markets imply 243 D seats (80% band 2xx–2xx at ρ=0.3); control market 94% ⇒ implied ρ 0.21."

**Live-night value**: as races are called, set p_i to 0 or 1, and for uncalled races with votes use idea 2's P(D). The "results-implied control probability" can then be compared tick-by-tick with the control market. A gap of more than 5 pt for more than 2 minutes is a genuine "market lagging" or "market leading" flag.

**Failure modes**
- Thin race markets: 36 races are Polymarket-only, some with wide spreads. Weight the Kalshi/Polymarket average by volume.
- Longshot bias: 1–3¢ floors on near-certain races add about 0.5 seats. Clip p to ≥ 0.99 or ≤ 0.01 when the rating is "solid".
- Seats with no market fall back to the rating map, which is crude for lean seats without a market. There are none today, since all 81 non-solid seats have one.
- ρ is not a stable "true" parameter. Present it as an implied quantity, not as evidence of mispricing.
- Senate needs the 65 seats not up (34 D / 31 R per NYT), and D needs 51, because the VP breaks ties for R. Treat independents (King, Sanders) as D.
- PredictIt seat-count brackets (verified live) would be a direct cross-check of the seat distribution. Effort +S.

---

## 4. Markets-vs-results scorecard (Brier and calibration). **Downgrade; keep only an "upset list".** Effort S, value 2 (full scorecard) / 3 (upset list)

- Brier score = mean (p_i − y_i)², and log loss = −mean log p(winner).
- p must be a **snapshot at that state's poll close**. The latest price has already converged to 0 or 1 by call time, so it scores trivially well. That requires the server to snapshot all 116 markets at each `pollClosing` time; those times are in `state.nyt.pollClosing`.
- Rejecting the full calibration plot:
  - About 116 races sharing one national shock gives roughly 1 effective observation for calibration.
  - Kalshi and Polymarket are arbitraged against each other (median gap 0.55 pt), so their Brier difference is noise.
  - The only meaningful baseline is NYT ratings mapped to probabilities, and even that tells you only "the environment was D or R relative to consensus", which idea 1 already says.
- **Keep the cheap version**: an "upsets" list of called races sorted by poll-close p of the eventual winner, with surprisal −log₂ p. People do look at that. It is post-hoc, so its value is mostly late in the night.

---

## 5. Odds momentum (biggest movers over 15/30/60 min). **Keep.** Effort S, value 4

**Math**
- Store a ring buffer of `state.markets` (116 races × {kD, pD, kVol, pVol}) every 30 s for 2 h. That is about 28k numbers.
- Δ_h = p(t) − p(t−h) in points, and Δlogit_h = logit p(t) − logit p(t−h). **Rank by |Δlogit|**, so that 92→99 and 45→60 are comparable. Show the pt change.
- Noise filter: count a move only when both sources agree in sign (if both exist) **or** volume rose by more than X since t−h. Otherwise grey it out.
- Kalshi mid = (bid+ask)/2. Discard the tick when ask−bid > 15¢.
- Backfill after a restart:
  - Kalshi candlesticks with `period_interval=1` (verified endpoint).
  - Polymarket `prices-history` needs `clobTokenIds`, which Gamma already returns, so keep them in `pickPartyMarkets`.
- Add control markets from the existing `history`.

**Failure modes**
- Called races jump to 99. Tag them "called" and exclude them from the ranking, or better, show "market moved N min before the AP call", which is a fun and true stat.
- Polymarket and Kalshi API stalls create fake zero-moves. Mark data as stale if `updatedAt` is older than 2 polls.

---

## 6. Early-vote-adjusted swing from the UF early-vote CSV. **Reject as a swing adjuster; keep only as a first-drop benchmark (optional).** Effort S, value 2

Why I reject it:
- UF is **state-level only** (49 rows; the per-state CSVs 404), but the swing model works at county and district level.
- Party registration exists in only about 30 states, and registration-to-vote conversion is unknown: NPA and unaffiliated voters are 25–35% in FL and NC.
- The 2026 "early vote = D" relationship is weaker than in 2020 because the GOP pushed early voting.
- A proper adjustment needs a vote-by-type split of the counted votes, which `eevp_by_vote_type` (if AP fills it) or NC SBE `evc/ovc/avc` provide directly and much better.

What is worth keeping, for FL and NC only, where early votes are reported first and parties are registered: the first-drop benchmark m̂_early ≈ κ·(D_reg − R_reg)/voted_all, with κ ≈ 0.8. If the first statewide or district drop beats m̂_early, Democrats are winning NPA voters or getting crossover. This is cute, but κ is a guess.

---

## 7. Poll error (live minus polling average) carried into later-closing races. **Keep, but only on projected-final margins and with a forward use.** Effort M, value 4

**Math**
- Use only races that are called, or where f_i < 0.15 and idea 2 has a projection.
- Error: δ_i = M_i(projected final) − poll_i. **Never use the raw live margin**, because the count-order bias would show up as poll error.
- Use the two-party-comparable margin: both are D−R of total, which matches if VoteHub's dem/rep percentages are of all respondents. Undecideds shrink poll margins, so better to compare the D share of the two-party vote: d = D/(D+R), with δ = 2·(d_res − d_poll)·100 in margin points.
- Weights: w_i = n_i/(n_i + 2) · 1/(σ_i²). Here n_i is the number of nonpartisan polls (exclude `internal` and `partisan`, which polls.js already flags), and σ_i² = 4² + 25/n_i. Senate and governor races share states, so cluster by state.
- National miss: δ̂ = Σ w δ / Σ w, with a state-clustered SE.
- Also report δ_GB = (−1.5 + ŝ from idea 1) − GB_poll, which is the cleanest single "polling miss" number.
- **Forward use (the useful part).** For uncalled races with polls and no or little vote (the West after 10pm), P(D) = Φ((poll_i + δ̂) / √(σ_i² + SE(δ̂)²)). Show it next to the market. This is where a viewer actually gets an edge at 10–11pm ET.

**Failure modes**
- Early-reporting states (FL, GA, NC, OH, PA) are not representative of Western polling errors. Polling error is regionally and demographically correlated, e.g. with the Hispanic share.
- Only 70 House races have polls, many of them single internals.
- The averaging windows differ by race: `windowDays` adapts.

---

## 8. Time-to-call estimator from the eevp trajectory. **Reject the ETA; replace it with "trailer needs X% of the remaining vote".** Effort S, value 5

Why reject the ETA:
- Counts arrive in batches with overnight pauses. CA, NV, AZ and WA take days, and the AP call depends on AP's internal expected-vote confidence, not on eevp crossing a threshold.
- A linear fit of e(t) gives ETAs that are wrong in exactly the races people care about.

**Replacement** (two-candidate case, using the race's own E):
- Lead L = |D_votes − R_votes|, and outstanding R_out = max(0, E_i − V_i).
- Required margin among the remaining vote for the trailer: m_req = 100·L / R_out (pts). Equivalently, the trailer needs 50% + m_req/2 of the two-party remaining vote.
- Compare it with what the remaining vote is expected to do. From idea 2, the remaining margin from the trailer's perspective is m_rem = Σ_j (E_j−V_j)(b_j+ŝ_i) / Σ(E_j−V_j).
- Show a **"safety ratio"** z = (m_req − m_rem_for_trailer)/σ_rem. When z > 3, the race is effectively over. That usually precedes the AP call and is a good "why hasn't this been called?" explainer.
- If R_out ≤ 0 but the race is uncalled, label it "provisionals / cures only".

Failure modes: if AP's E is too low (big late mail), R_out is understated, so the ratio is too optimistic. Inflate R_out by 10% where the state is mail-heavy (CA, NV, AZ, WA, OR, UT, CO).

---

## 9. Other ideas

- **9a. Check `nyt_model_estimates` first.** Effort S, value 5 if populated, 0 otherwise. The fields exist at race, unit and candidate level, plus `model_settings.model_status`. If NYT fills them tonight, display NYT's estimate next to ours and next to the markets. It is a 20-line change.
- **9b. Live seat projection.** Effort M (after ideas 2 and 3), value 5. Combine:
  - called races = 0/1
  - races with votes = idea 2's P(D)
  - races with no votes = market p, or the poll-adjusted p from idea 7
  - races with no market = rating p.

  Then apply idea 3's one-factor model with ρ ≈ 0.2–0.3, using ŝ's posterior σ as the common shock. Output: "D 238 seats (90%: 229–247), P(control) 97%", next to the control market. This is the headline number a sharp viewer wants. It is essentially ideas 2 and 3 composed, so it is cheap once those exist.
- **9c. County swing heatmap for all House seats.** Effort S once the units are kept, value 3. s_j = m_j − b_j per county piece, shown in the existing district map or a modal list sorted by expected vote. The data is verified to be there.
- **9d. Expected-vote revision tracker.** Effort S, value 2–3. Store E at 7pm and show ΔE% per state over the night. AP raising E is the first visible turnout-surprise signal.
- **9e. Fix the existing bellwether projection now.** Effort S, value 3. Replace w = totalVotes with w = E·min(1, eevp/50), and apply the prior shrinkage from idea 1. Otherwise the current "from bellwethers" number will swing wildly at 7:15pm on IN-1, VA-2 and FL mail drops.

---

## Ranked top 5 for tonight

1. **"Trailer needs X% of remaining" plus the safety ratio** (idea 8 replacement). S effort, value 5. It uses fields the server already has (E, V, candidate votes), and the projected-remaining comparison can come later. Do 9a (check `nyt_model_estimates`) at the same time, since it is 5 minutes.
2. **County benchmark per-race projection with P(D), flagged against the markets** (idea 2). M effort, value 5. The data is verified for 434 House races, with new-line county-piece 2024 margins. It needs the server to keep unit-level `historical_comparison_race_data` for all races.
3. **District-sum national needle with a generic-ballot prior and state-clustered SE** (idea 1, including fix 9e). M effort, value 5. It reuses idea 2 and replaces the biased bellwether projection.
4. **Odds momentum ranked by logit change, with a noise filter and "moved before the call"** (idea 5). S effort, value 4. It needs a per-race ring buffer; there is no race history today.
5. **Market-implied seats and implied correlation vs the control market** (idea 3, upgrading to 9b live seat projection once idea 2 exists). S–M effort, value 4. A live check now gives 242.6 implied D seats and an implied ρ ≈ 0.2, which matches the 94% control price.

Next in line: poll-miss carry-forward to the West (idea 7, value 4 after about 10pm). Not recommended: the full Brier/calibration scorecard (idea 4), UF early-vote swing adjustment (idea 6), and an eevp-trajectory call ETA (idea 8 as proposed).
