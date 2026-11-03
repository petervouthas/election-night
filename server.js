// Election Night 2026 dashboard server. No dependencies. Node 18+.
// Polls Kalshi, Polymarket and the NYT results feed, keeps a short in-memory
// history, and serves one page at http://localhost:3000.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PUBLIC = path.join(ROOT, 'public');

// ---------------------------------------------------------------- config
let config = null;
let configMtime = 0;
function loadConfig() {
  try {
    const st = fs.statSync(CONFIG_PATH);
    if (st.mtimeMs !== configMtime) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      configMtime = st.mtimeMs;
      log('config loaded');
    }
  } catch (e) {
    recordError('config', `config.json: ${e.message}`);
    if (!config) throw e;
  }
  return config;
}

// ---------------------------------------------------------------- state
const state = {
  startedAt: Date.now(),
  updatedAt: null,
  kalshi: { updatedAt: null, control: {}, races: {} },
  polymarket: { updatedAt: null, control: {}, races: {} },
  nyt: { updatedAt: null, resultsUpdatedAt: null, control: {}, races: {}, house: [], senate: [] },
  history: [],   // [{t, kH, pH, kS, pS}]
  errors: [],    // [{t, source, msg}]
};

function log(...a) { console.log(new Date().toISOString(), ...a); }
function recordError(source, msg) {
  const e = { t: Date.now(), source, msg: String(msg).slice(0, 300) };
  state.errors.unshift(e);
  if (state.errors.length > 60) state.errors.length = 60;
  console.error(new Date().toISOString(), `[${source}]`, e.msg);
}

async function getJSON(url, timeoutMs = 20000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'accept': 'application/json', 'user-agent': 'Mozilla/5.0 election-night-dashboard' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

const num = v => (v === null || v === undefined || v === '' ? null : Number(v));

// ---------------------------------------------------------------- Kalshi
// One request: all "Democrat wins" market tickers, comma separated.
async function pollKalshi(cfg) {
  const tickers = [];
  for (const k of Object.keys(cfg.control)) if (cfg.control[k].kalshi) tickers.push(cfg.control[k].kalshi);
  for (const r of cfg.races) if (r.kalshi) tickers.push(r.kalshi);
  if (!tickers.length) return;
  const data = await getJSON(`${cfg.sources.kalshi}/markets?tickers=${encodeURIComponent(tickers.join(','))}`);
  const byTicker = {};
  for (const m of data.markets || []) {
    const bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars), last = num(m.last_price_dollars);
    let p = null;
    if (bid !== null && ask !== null && ask > 0) p = (bid + ask) / 2;
    else if (last !== null) p = last;
    byTicker[m.ticker] = {
      pD: p === null ? null : Math.round(p * 1000) / 10,   // percent, 0.1 precision
      bid, ask, last,
      volume: num(m.volume_fp),
      status: m.status,
      title: m.title,
    };
  }
  const missing = tickers.filter(t => !byTicker[t]);
  if (missing.length) recordError('kalshi', `no market returned for ${missing.join(', ')}`);
  for (const k of Object.keys(cfg.control)) state.kalshi.control[k] = byTicker[cfg.control[k].kalshi] || null;
  for (const r of cfg.races) state.kalshi.races[r.id] = r.kalshi ? (byTicker[r.kalshi] || null) : null;
  state.kalshi.updatedAt = Date.now();
}

// ---------------------------------------------------------------- Polymarket
// One request: every event slug we care about. Within each event, find the
// Democratic and Republican markets and use the Yes price (mid).
function pickPartyMarkets(event) {
  const out = { D: null, R: null };
  for (const m of event.markets || []) {
    const slug = (m.slug || '').toLowerCase();
    const title = (m.groupItemTitle || m.question || '').toLowerCase();
    let party = null;
    if (/democrat/.test(slug) || /\(d\)\s*$/.test(title) || /democratic party/.test(title)) party = 'D';
    else if (/republican/.test(slug) || /\(r\)\s*$/.test(title) || /republican party/.test(title)) party = 'R';
    if (!party || out[party]) continue;
    let prices = null;
    try { prices = JSON.parse(m.outcomePrices || 'null'); } catch { prices = null; }
    const yes = prices && prices.length ? num(prices[0]) : null;
    const bid = num(m.bestBid), ask = num(m.bestAsk);
    const mid = (bid !== null && ask !== null && ask > 0) ? (bid + ask) / 2 : null;
    const p = yes !== null ? yes : mid;
    out[party] = {
      p: p === null ? null : Math.round(p * 1000) / 10,
      yes, bid, ask, last: num(m.lastTradePrice),
      volume: num(m.volumeNum ?? m.volume),
      name: m.groupItemTitle || m.question,
      slug: m.slug,
    };
  }
  return out;
}

async function pollPolymarket(cfg) {
  const slugs = [];
  for (const k of Object.keys(cfg.control)) if (cfg.control[k].polymarketEvent) slugs.push(cfg.control[k].polymarketEvent);
  for (const r of cfg.races) if (r.polymarket) slugs.push(r.polymarket);
  if (!slugs.length) return;
  const q = slugs.map(s => `slug=${encodeURIComponent(s)}`).join('&');
  const events = await getJSON(`${cfg.sources.polymarket}/events?limit=100&${q}`);   // default limit is 20, max 100 slugs per call
  const bySlug = {};
  for (const e of Array.isArray(events) ? events : []) {
    const pm = pickPartyMarkets(e);
    bySlug[e.slug] = {
      pD: pm.D ? pm.D.p : null,
      pR: pm.R ? pm.R.p : null,
      D: pm.D, R: pm.R,
      title: e.title, volume: num(e.volume), closed: !!e.closed,
    };
  }
  const missing = slugs.filter(s => !bySlug[s]);
  if (missing.length) recordError('polymarket', `no event returned for ${missing.join(', ')}`);
  for (const k of Object.keys(cfg.control)) state.polymarket.control[k] = bySlug[cfg.control[k].polymarketEvent] || null;
  for (const r of cfg.races) state.polymarket.races[r.id] = r.polymarket ? (bySlug[r.polymarket] || null) : null;
  state.polymarket.updatedAt = Date.now();
}

// ---------------------------------------------------------------- NYT results
// Public JSON used by the NYT results pages. Large (House ~7 MB), so it runs
// on its own slower interval and is condensed to what the page needs.
function partyOf(meta) {
  const id = meta && meta.party && (meta.party.nyt_id || meta.party.abbreviation || meta.party);
  if (!id) return 'O';
  const s = String(id).toUpperCase();
  if (s.startsWith('DEM') || s === 'D') return 'D';
  if (s.startsWith('GOP') || s.startsWith('REP') || s === 'R') return 'R';
  return 'O';
}

function condenseRace(r, wantCounties) {
  const tru = r.top_reporting_unit || {};
  const metas = r.candidate_metadata || {};
  const total = num(tru.total_votes) || 0;
  const cands = (tru.candidates || [])
    .filter(c => c.nyt_id !== 'total_writeins')
    .map(c => {
      const m = metas[c.nyt_id] || {};
      const votes = num(c.votes && c.votes.total) || 0;
      return {
        id: c.nyt_id,
        name: [m.first_name, m.last_name].filter(Boolean).join(' ') || c.nyt_id,
        last: m.last_name || c.nyt_id,
        party: partyOf(m),
        incumbent: !!m.incumbent,
        votes,
        pct: total ? Math.round(votes / total * 1000) / 10 : null,
        leader: !!c.leader,
        won: (r.outcome && r.outcome.won || []).includes(c.nyt_id),
      };
    })
    .sort((a, b) => b.votes - a.votes);

  const d = cands.find(c => c.party === 'D'), g = cands.find(c => c.party === 'R');
  // Margin, pct pts, positive = the non-Republican side. D minus R when both exist; otherwise the
  // leader of the race vs the runner-up, signed by party (same-party top-two races, independents like NE).
  let liveMargin = null;
  if (total && d && g) liveMargin = Math.round((d.pct - g.pct) * 10) / 10;
  else if (total && cands.length > 1 && cands[0].pct !== null && cands[1].pct !== null) { const gap = cands[0].pct - cands[1].pct; liveMargin = Math.round((cands[0].party === 'R' ? -gap : gap) * 10) / 10; }
  const won = cands.find(c => c.won);
  const runoff = !!(r.outcome && Array.isArray(r.outcome.advanced_to_runoff) && r.outcome.advanced_to_runoff.length);
  const gainedRaw = r.outcome && r.outcome.gained;
  const gained = gainedRaw ? partyOf({ party: typeof gainedRaw === 'string' ? { nyt_id: gainedRaw } : gainedRaw }) : null;
  const leader = cands.find(c => c.leader) || (total ? cands[0] : null);
  const hist = tru.historical_comparison_race_data || {};
  const histKey = Object.keys(hist).find(k => /-P-2024-/.test(k));
  const margin2024 = histKey ? num(hist[histKey].margin) : null;

  const out = {
    id: r.nyt_id,
    state: (r.nyt_id || '').split('-')[0],
    office: r.office_id,                  // H or S
    seat: r.seat_number,
    seatLabel: r.seat,
    rating: r.rating,
    callStatus: r.race_call_status,       // too_early | called | ...
    uncontested: !!r.uncontested,
    inPartyControl: !!r.in_party_control,
    eevp: num(tru.eevp),
    totalVotes: total,
    expectedVotes: num(tru.total_expected_vote),
    precinctsReporting: num(tru.precincts_reporting),
    precinctsTotal: num(tru.precincts_total),
    providerUpdatedAt: tru.provider_updated_at || null,
    winnerParty: won ? won.party : null,
    leaderParty: leader && total ? leader.party : null,
    liveMargin,
    margin2024,
    runoff, gained,
    quiet: !!(r.uncontested || (r.rating && String(r.rating).startsWith('solid'))),   // safe seat: shown in the feed, kept off the tape
    candidates: cands.slice(0, 4),
    url: r.url,
  };
  if (wantCounties) {
    out.counties = (r.reporting_units || []).filter(u => u.level === 'county').map(u => {
      const t = num(u.total_votes) || 0;
      const cs = (u.candidates || []).filter(c => c.nyt_id !== 'total_writeins').map(c => {
        const v = num(c.votes && c.votes.total) || 0;
        return { id: c.nyt_id, party: partyOf(metas[c.nyt_id]), votes: v, pct: t ? Math.round(v / t * 1000) / 10 : null };
      });
      const cd = cs.find(c => c.party === 'D'), cg = cs.find(c => c.party === 'R');
      const uh = u.historical_comparison_race_data || {}; const uk = Object.keys(uh).find(k => /-P-2024-/.test(k));
      return {
        name: u.name, fips: `${u.fips_state}${u.fips_county}`, eevp: num(u.eevp), totalVotes: t,
        expectedVotes: num(u.total_expected_vote), margin2024: uk ? num(uh[uk].margin) : null,
        liveMargin: (t && cd && cg) ? Math.round((cd.pct - cg.pct) * 10) / 10 : null,
      };
    });
  }
  return out;
}

function condenseControl(pc, officeId) {
  try {
    const o = pc.results[0].offices[officeId];
    const pb = o.party_balance || {};
    return {
      total: o.total, toWin: o.to_win && (o.to_win.DEM ?? 218), called: o.num_races_called,
      seatsD: pb.DEM ? pb.DEM.seats : 0, seatsR: pb.GOP ? pb.GOP.seats : 0, seatsO: pb.OTH ? pb.OTH.seats : 0,
      flipsD: pb.DEM ? pb.DEM.flip_count : 0, flipsR: pb.GOP ? pb.GOP.flip_count : 0,
      notUpD: pb.DEM ? pb.DEM.no_election : 0, notUpR: pb.GOP ? pb.GOP.no_election : 0, notUpO: pb.OTH ? pb.OTH.no_election : 0,
      currentControl: o.current_control || null,
      winner: pb.DEM && pb.DEM.winner ? 'D' : pb.GOP && pb.GOP.winner ? 'R' : null,
    };
  } catch { return null; }
}

// candidate -> party index used to map VoteHub poll answers (names only) to parties
function buildNytIndex(houseRaces, senateRaces, govRaces) {
  const idx = { senate: {}, governor: {}, house: {} };
  const cands = r => r.candidates.map(c => ({ last: c.last, name: c.name, party: c.party }));
  for (const r of senateRaces) (idx.senate[r.state] = idx.senate[r.state] || []).push(...cands(r));
  for (const r of govRaces) (idx.governor[r.state] = idx.governor[r.state] || []).push(...cands(r));
  for (const r of houseRaces) if (r.seat) idx.house[`${r.state}-${parseInt(r.seat, 10) || r.seat}`] = cands(r);
  return idx;
}

async function pollNYT(cfg) {
  const want = new Set(cfg.races.map(r => r.nyt).filter(Boolean));
  // each file is independent: a failed Senate fetch must not throw away a good House payload
  const results = await Promise.allSettled([
    getJSON(cfg.sources.nytHouse, 45000),
    getJSON(cfg.sources.nytSenate, 45000),
    cfg.sources.nytGovernor ? getJSON(cfg.sources.nytGovernor, 45000) : Promise.resolve({ races: [] }),
  ]);
  const [hs, ss, gs] = results;
  for (const [name, r] of [['house', hs], ['senate', ss], ['governor', gs]]) if (r.status === 'rejected') recordError('nyt', `${name}: ${r.reason && r.reason.message || r.reason}`);
  if (hs.status === 'rejected' && ss.status === 'rejected') throw new Error('house and senate feeds both failed');
  const house = hs.status === 'fulfilled' ? hs.value : null, senate = ss.status === 'fulfilled' ? ss.value : null, gov = gs.status === 'fulfilled' ? gs.value : null;
  const houseRaces = house ? (house.races || []).filter(r => r.nyt_id && !r.nyt_id.startsWith('US-')).map(r => condenseRace(r, want.has(r.nyt_id))) : (state.nyt.house || []);
  if (house) { const natRaw = (house.races || []).find(r => r.nyt_id && r.nyt_id.startsWith('US-')); state.nyt.national = natRaw ? condenseRace(natRaw, false) : state.nyt.national || null; }
  const senateRaces = senate ? (senate.races || []).map(r => condenseRace(r, want.has(r.nyt_id))) : (state.nyt.senate || []);
  const govRaces = gov ? (gov.races || []).map(r => condenseRace(r, want.has(r.nyt_id))) : (state.nyt.governor || []);
  const refreshed = [].concat(house ? houseRaces : [], senate ? senateRaces : [], gov ? govRaces : []);
  const byId = {};
  for (const r of houseRaces.concat(senateRaces, govRaces)) byId[r.id] = r;
  state.nyt.house = houseRaces;
  state.nyt.senate = senateRaces;
  state.nyt.governor = govRaces;
  state.nyt.index = buildNytIndex(houseRaces, senateRaces, govRaces);
  state.extra = buildExtraMarkets(cfg, houseRaces, senateRaces);
  try { detectResultEvents(cfg, refreshed); } catch (e) { recordError('events', e.message); }
  state.nyt.races = {};
  for (const r of cfg.races) state.nyt.races[r.id] = r.nyt ? (byId[r.nyt] || null) : null;
  const missing = cfg.races.filter(r => r.nyt && !byId[r.nyt]).map(r => r.nyt);
  if (missing.length) recordError('nyt', `race id not in feed: ${missing.join(', ')}`);
  state.nyt.control = {
    house: house ? condenseControl(house.partyControlData, cfg.control.house.nytOffice || 'H') : (state.nyt.control || {}).house || null,
    senate: senate ? condenseControl(senate.partyControlData, cfg.control.senate.nytOffice || 'S') : (state.nyt.control || {}).senate || null,
  };
  try { detectControlEvents(state.nyt.control); } catch (e) { recordError('events', e.message); }
  if (house) {
    state.nyt.pollClosing = (house.pollClosingTimes || []).map(p => ({ state: p.reporting_unit && p.reporting_unit.state_postal, t: p.poll_closing_time }));
    state.nyt.resultsUpdatedAt = house.resultsMeta && house.resultsMeta.resultsUpdatedAt || null;
  }
  state.nyt.updatedAt = Date.now();
}

// ---------------------------------------------------------------- extra markets (every Senate race + competitive House)
// Ticker/slug patterns verified Nov 2 2026: Kalshi HOUSE<ST><N>-26-D / SENATE<ST>-26-D,
// Polymarket st-NN-house-election-winner / <state-name>-senate-election-winner.
const STATE_SLUG = { AL:'alabama',AK:'alaska',AZ:'arizona',AR:'arkansas',CA:'california',CO:'colorado',CT:'connecticut',DE:'delaware',FL:'florida',GA:'georgia',HI:'hawaii',ID:'idaho',IL:'illinois',IN:'indiana',IA:'iowa',KS:'kansas',KY:'kentucky',LA:'louisiana',ME:'maine',MD:'maryland',MA:'massachusetts',MI:'michigan',MN:'minnesota',MS:'mississippi',MO:'missouri',MT:'montana',NE:'nebraska',NV:'nevada',NH:'new-hampshire',NJ:'new-jersey',NM:'new-mexico',NY:'new-york',NC:'north-carolina',ND:'north-dakota',OH:'ohio',OK:'oklahoma',OR:'oregon',PA:'pennsylvania',RI:'rhode-island',SC:'south-carolina',SD:'south-dakota',TN:'tennessee',TX:'texas',UT:'utah',VT:'vermont',VA:'virginia',WA:'washington',WV:'west-virginia',WI:'wisconsin',WY:'wyoming' };
function buildExtraMarkets(cfg, houseRaces, senateRaces) {
  const mode = cfg.extraMarkets || 'competitive';   // competitive | all | none
  if (mode === 'none') return [];
  const out = [];
  const ov = cfg.polymarketSlugOverrides || {};
  for (const r of senateRaces) out.push({ id: `${r.state}-Sen`, kalshi: `SENATE${r.state}-26-D`, polymarket: ov[`${r.state}-Sen`] || `${STATE_SLUG[r.state]}-senate-election-winner` });
  for (const r of houseRaces) {
    const n = parseInt(r.seat, 10); if (!n) continue;
    if (mode === 'competitive' && (!r.rating || r.rating.startsWith('solid') || r.uncontested)) continue;
    out.push({ id: `${r.state}-${n}`, kalshi: `HOUSE${r.state}${n}-26-D`, polymarket: ov[`${r.state}-${n}`] || `${r.state.toLowerCase()}-${String(n).padStart(2, '0')}-house-election-winner` });
  }
  return out;
}
async function pollExtraMarkets(cfg) {
  const extra = state.extra || [];
  if (!extra.length) return;
  const markets = state.markets || {};
  const tickers = extra.map(e => e.kalshi);
  const [kres, ...pchunks] = await Promise.all([
    getJSON(`${cfg.sources.kalshi}/markets?limit=1000&tickers=${encodeURIComponent(tickers.join(','))}`).catch(e => { recordError('kalshi', 'extra: ' + e.message); return null; }),
    ...chunk(extra.map(e => e.polymarket), 100).map(slugs =>
      getJSON(`${cfg.sources.polymarket}/events?limit=100&${slugs.map(s => `slug=${encodeURIComponent(s)}`).join('&')}`).catch(e => { recordError('polymarket', 'extra: ' + e.message); return []; })),
  ]);
  const kFailed = !kres, pFailedChunks = pchunks.map(c => !Array.isArray(c) || c.length === 0);
  const kBy = {}, pBy = {};
  for (const m of (kres && kres.markets) || []) {
    const bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars), last = num(m.last_price_dollars);
    const p = (bid !== null && ask !== null && ask > 0) ? (bid + ask) / 2 : last;
    kBy[m.ticker] = { pD: p === null ? null : Math.round(p * 1000) / 10, volume: num(m.volume_fp) };
  }
  for (const ev of pchunks.flat()) { if (ev && ev.slug) { const pm = pickPartyMarkets(ev); pBy[ev.slug] = { pD: pm.D ? pm.D.p : null, volume: num(ev.volume) }; } }
  const slugChunk = {}; chunk(extra.map(e => e.polymarket), 100).forEach((c, i) => c.forEach(s => slugChunk[s] = i));
  for (const e of extra) {
    const k = kBy[e.kalshi], p = pBy[e.polymarket], prev = markets[e.id] || {};
    const pFailed = pFailedChunks[slugChunk[e.polymarket]];
    // a failed fetch keeps the last good value instead of blanking a hundred markets for a cycle
    markets[e.id] = {
      kD: kFailed ? (prev.kD ?? null) : (k ? k.pD : null), kVol: kFailed ? (prev.kVol ?? null) : (k ? k.volume : null),
      pD: pFailed ? (prev.pD ?? null) : (p ? p.pD : null), pVol: pFailed ? (prev.pVol ?? null) : (p ? p.volume : null),
    };
  }
  state.markets = markets;
  state.marketsUpdatedAt = Date.now();
}
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// ---------------------------------------------------------------- VoteHub polls
let pollsMod = null;
try { pollsMod = require('./polls.js'); } catch (e) { recordError('polls', 'polls.js not loaded: ' + e.message); }
let rawPolls = null;
async function pollVoteHub(cfg) {
  if (!pollsMod) return;
  const url = cfg.sources.votehub || 'https://api.votehub.com/polls';
  try { rawPolls = await pollsMod.fetchPolls(url); }
  catch (e) { recordError('polls', e.message); if (!rawPolls) return; }
  if (!state.nyt.index) return; // aggregate once the NYT candidate index exists
  state.polls = pollsMod.aggregatePolls(rawPolls, state.nyt.index, { now: Date.now() });
  state.polls.updatedAt = Date.now();
}

// ---------------------------------------------------------------- FEC spending (static over the night)
let spendingMod = null;
try { spendingMod = require('./spending.js'); } catch (e) { recordError('spending', 'spending.js not loaded: ' + e.message); }
async function loadSpendingOnce(cfg) {
  if (!spendingMod) return;
  try {
    fs.mkdirSync(path.join(ROOT, 'cache'), { recursive: true });
    state.spending = await spendingMod.loadSpending({
      cacheFile: path.join(ROOT, 'cache', 'fec-spending.json'),
      weballUrl: cfg.sources.fecWeball, ieUrl: cfg.sources.fecIE,
      maxAgeMs: 6 * 3600e3, log: m => log('[spending]', m),
    });
    log('spending loaded');
  } catch (e) { recordError('spending', e.message); }
}

// ---------------------------------------------------------------- events (calls, flips, lead changes, line crossings, odds moves)
state.events = [];          // newest first, capped
let eventSeq = 0;
eventSeq = Date.now();      // seeded with the clock so a restart never reuses sequence numbers the page has seen
function pushEvent(ev) {
  ev.t = ev.t || Date.now(); ev.seq = ++eventSeq;
  state.events.unshift(ev);
  if (state.events.length > 5000) state.events.length = 5000;
  log('[event]', ev.type, ev.id || '', ev.text);
}
const PARTY_NAME = { D: 'D', R: 'R', O: 'I' };
function raceLabel(r) { return r.office === 'S' ? `${r.state} Senate` : r.office === 'G' ? `${r.state} Governor` : `${r.state}-${parseInt(r.seat, 10) || r.seat}`; }
function raceKey(r) { return r.office === 'S' ? `${r.state}-Sen` : r.office === 'G' ? `${r.state}-Gov` : `${r.state}-${parseInt(r.seat, 10) || r.seat}`; }
function holderParty(r) { const inc = r.candidates.find(c => c.incumbent); return inc ? inc.party : null; }
let prevRaces = null;       // id -> condensed race from the previous NYT poll
const announcedLead = {};   // id -> {party, t}: last lead change we announced (hysteresis + cooldown)
const announcedCross = {};  // id -> {side, t}
const firstVotesSeen = new Set();
function detectResultEvents(cfg, allRaces) {
  const cur = {}; for (const r of allRaces) cur[raceKey(r)] = r;
  if (prevRaces) {
    const bell = new Set(cfg.races.map(x => x.id)), prior = cfg.priorParty || {};
    for (const [id, r] of Object.entries(cur)) {
      const p = prevRaces[id]; if (!p) continue;
      const lbl = raceLabel(r), winner = r.candidates.find(c => c.won);
      // AP / NYT call. Holder = incumbent's party, else config priorParty (open seats); NYT's outcome.gained wins when present.
      if (r.winnerParty && !p.winnerParty) {
        const holder = holderParty(r) || prior[id] || null;
        const flip = r.gained ? true : (holder ? r.winnerParty !== holder : null);
        pushEvent({ type: 'call', id, office: r.office, state: r.state, party: r.winnerParty, flip, holder, quiet: !!r.quiet && !flip,
          text: `${lbl} called for ${winner ? winner.name : r.winnerParty} (${PARTY_NAME[r.winnerParty] || r.winnerParty})${flip ? ` · FLIP${holder ? ' from ' + PARTY_NAME[holder] : ''}` : ''}`,
          meta: { eevp: r.eevp, liveMargin: r.liveMargin, margin2024: r.margin2024, rating: r.rating } });
        if (flip) pushEvent({ type: 'flip', id, office: r.office, state: r.state, party: r.winnerParty, holder, text: `${lbl} flips ${holder ? PARTY_NAME[holder] + ' → ' : 'to '}${PARTY_NAME[r.winnerParty]}` });
      }
      // runoff
      if (r.runoff && !p.runoff) pushEvent({ type: 'runoff', id, office: r.office, state: r.state, party: r.leaderParty, text: `${lbl} goes to a runoff` });
      // lead change: ≥15% in, the new leader must be ≥0.5 pt clear, and at most one announcement per race per 10 min
      if (!r.winnerParty && r.totalVotes && (r.eevp || 0) >= 15 && r.leaderParty) {
        const c = r.candidates, gap = c.length > 1 && c[0].pct !== null && c[1].pct !== null ? c[0].pct - c[1].pct : 0;
        const last = announcedLead[id] ? announcedLead[id].party : (p.totalVotes ? p.leaderParty : null);
        if (last && r.leaderParty !== last && gap >= 0.5 && Date.now() - ((announcedLead[id] || {}).t || 0) > 10 * 60e3) {
          announcedLead[id] = { party: r.leaderParty, t: Date.now() };
          const lead = r.candidates.find(c => c.leader) || r.candidates[0];
          pushEvent({ type: 'lead', id, office: r.office, state: r.state, party: r.leaderParty, text: `${lbl}: ${lead ? lead.name : r.leaderParty} takes the lead · ${r.eevp}% in · ${fmtMarginText(r.liveMargin)}`, meta: { eevp: r.eevp, liveMargin: r.liveMargin } });
        }
      }
      // bellwether crosses its 2024 line: needs ≥0.5 pt on the new side and 10 min since the last crossing
      if (bell.has(id) && r.liveMargin !== null && r.margin2024 !== null && (r.eevp || 0) >= 10) {
        const o = r.liveMargin - r.margin2024, side = o >= 0 ? 'D' : 'R';
        const lastSide = announcedCross[id] ? announcedCross[id].side : (p.liveMargin !== null && p.margin2024 !== null ? ((p.liveMargin - p.margin2024) >= 0 ? 'D' : 'R') : null);
        if (lastSide && side !== lastSide && Math.abs(o) >= 0.5 && Date.now() - ((announcedCross[id] || {}).t || 0) > 10 * 60e3) {
          announcedCross[id] = { side, t: Date.now() };
          pushEvent({ type: 'cross', id, office: r.office, state: r.state, party: side, text: `${lbl}: Democrats now ${o >= 0 ? 'ahead of' : 'behind'} the 2024 margin (${o >= 0 ? '+' : ''}${o.toFixed(1)}) · ${r.eevp}% in`, meta: { over: o, eevp: r.eevp } });
        }
      }
      // first votes in a bellwether (once)
      if (bell.has(id) && r.totalVotes && !p.totalVotes && !firstVotesSeen.has(id)) { firstVotesSeen.add(id); pushEvent({ type: 'first', id, office: r.office, state: r.state, party: r.leaderParty, text: `${lbl}: first votes · ${fmtMarginText(r.liveMargin)} · ${r.eevp}% in` }); }
    }
  }
  // keep ids from a feed that failed this round so their calls aren't missed next time
  prevRaces = Object.assign(prevRaces || {}, cur);
}
function fmtMarginText(v) { if (v === null || v === undefined) return '—'; return Math.abs(v) < .05 ? 'EVEN' : v > 0 ? `D+${v.toFixed(1)}` : `R+${(-v).toFixed(1)}`; }
let prevControl = {};
function detectControlEvents(control) {
  for (const k of ['house', 'senate']) {
    const c = control && control[k]; if (!c) continue;
    // first observation after a (re)start seeds the state silently, so a restart doesn't re-announce control
    if (!(k in prevControl)) { prevControl[k] = c.winner || null; continue; }
    if (c.winner && prevControl[k] !== c.winner) pushEvent({ type: 'control', id: k, party: c.winner, text: `${k.toUpperCase()} CONTROL called for ${c.winner === 'D' ? 'Democrats' : 'Republicans'}` });
    prevControl[k] = c.winner || null;
  }
}
// odds moves: per-race ring buffer (2 h) and an alert when a market moves >= oddsMovePts over oddsMoveWindowMs
state.raceHistory = {};     // id -> [[t, kD, pD], ...]
const lastOddsAlert = {};
function pushRaceHistory(cfg) {
  const now = Date.now(), keepMs = (cfg.historyHours || 2) * 3600e3;
  const byId = new Map(Object.entries(state.markets || {}));
  for (const r of cfg.races) { const k = state.kalshi.races[r.id], p = state.polymarket.races[r.id]; const prev = byId.get(r.id) || {}; byId.set(r.id, { kD: k ? k.pD : (prev.kD ?? null), pD: p ? p.pD : (prev.pD ?? null) }); }
  const entries = Array.from(byId.entries());
  const pts = cfg.oddsMovePts || 5, win = cfg.oddsMoveWindowMs || 30 * 60e3;
  for (const [id, m] of entries) {
    const h = state.raceHistory[id] = state.raceHistory[id] || [];
    h.push([now, m.kD ?? null, m.pD ?? null]);
    while (h.length && h[0][0] < now - keepMs) h.shift();
    // compare with the oldest point inside the window
    const base = h.find(x => x[0] >= now - win);
    if (!base || now - base[0] < 10 * 60e3) continue;
    for (const [idx, src] of [[1, 'Kalshi'], [2, 'Polymarket']]) {
      const a = base[idx], b = h[h.length - 1][idx]; if (a === null || b === null) continue;
      if (Math.abs(b - a) >= pts && (now - (lastOddsAlert[id + src] || 0)) > win) {
        lastOddsAlert[id + src] = now;
        pushEvent({ type: 'odds', id, party: b > a ? 'D' : 'R', text: `${id}: ${src} D ${a.toFixed(0)}% → ${b.toFixed(0)}% in ${Math.round((now - base[0]) / 60e3)} min`, meta: { src, from: a, to: b } });
      }
    }
  }
}
// snapshots: full odds + results state at configured ET times (default 6pm and midnight), written to cache/
state.snapshots = {};
function loadSnapshots() {
  try {
    const dir = path.join(ROOT, 'cache');
    for (const f of fs.readdirSync(dir)) if (/^snapshot-.*\.json$/.test(f)) { const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); state.snapshots[s.label] = s; }
  } catch {}
}
function takeSnapshot(label) {
  const snap = { label, t: Date.now(), control: { kalshi: state.kalshi.control, polymarket: state.polymarket.control, nyt: state.nyt.control }, markets: state.markets || {}, bell: {}, races: {} };
  for (const r of (loadConfig().races)) snap.bell[r.id] = { kD: state.kalshi.races[r.id] ? state.kalshi.races[r.id].pD : null, pD: state.polymarket.races[r.id] ? state.polymarket.races[r.id].pD : null };
  for (const r of (state.nyt.house || []).concat(state.nyt.senate || [], state.nyt.governor || [])) snap.races[raceKey(r)] = { winnerParty: r.winnerParty, leaderParty: r.leaderParty, liveMargin: r.liveMargin, eevp: r.eevp, totalVotes: r.totalVotes };
  state.snapshots[label] = snap;
  try { fs.mkdirSync(path.join(ROOT, 'cache'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'cache', `snapshot-${label.replace(/[^a-z0-9_-]/gi, '_')}.json`), JSON.stringify(snap)); } catch (e) { recordError('snapshot', e.message); }
  pushEvent({ type: 'snapshot', id: label, text: `Snapshot "${label}" saved` });
  return snap;
}
function etHHMM(d = new Date()) { return d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }); }
const snapDone = new Set();
function snapshotTick() {
  const cfg = loadConfig();
  const times = cfg.snapshotTimesET || ['18:00', '00:00'];
  const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const nowMin = toMin(etHHMM());
  for (const t of times) {
    const late = (nowMin - toMin(t) + 1440) % 1440;           // minutes since the scheduled time
    if (late > 30 || !state.nyt.updatedAt) continue;          // up to 30 min late is fine (laptop asleep, slow fetch)
    const key = t + ':' + new Date(Date.now() - late * 60e3).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
    if (snapDone.has(key)) continue;
    const label = t === '00:00' ? 'midnight' : t === '18:00' ? '6pm' : t;
    if (state.snapshots[label] && Date.now() - state.snapshots[label].t < 12 * 3600e3) { snapDone.add(key); continue; }   // already have a recent one (restart)
    snapDone.add(key); takeSnapshot(label);
  }
}
process.on('uncaughtException', e => recordError('fatal', (e && e.stack) || String(e)));
process.on('unhandledRejection', e => recordError('fatal', (e && e.stack) || String(e)));

// ---------------------------------------------------------------- hometown lookup: zip -> city/county/state -> 2026 House district
let ZIPS = null, DISTRICT_FEATURES = null, geoLib = null;
function loadZips() {
  if (ZIPS) return ZIPS;
  ZIPS = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, 'data', 'us-zips.tsv'), 'utf8').split('\n')) {
      if (!line || line[0] === '#') continue;
      const [zip, city, state, county, lat, lon] = line.split('\t');
      ZIPS[zip] = { zip, city, state, county, lat: +lat, lon: +lon };
    }
  } catch (e) { recordError('zip', 'zip table: ' + e.message); }
  return ZIPS;
}
function loadDistrictFeatures() {
  if (DISTRICT_FEATURES) return DISTRICT_FEATURES;
  try {
    const topojson = require(path.join(PUBLIC, 'vendor', 'topojson-client.min.js'));
    geoLib = require(path.join(PUBLIC, 'vendor', 'd3.v7.min.js'));
    const t = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'vendor', 'districts.json'), 'utf8'));
    DISTRICT_FEATURES = topojson.feature(t, t.objects.districts).features;
  } catch (e) { recordError('zip', 'district geometry: ' + e.message); DISTRICT_FEATURES = []; }
  return DISTRICT_FEATURES;
}
function zipLookup(zipRaw) {
  const zip = String(zipRaw || '').trim().slice(0, 5);
  if (!/^\d{5}$/.test(zip)) return null;
  const z = loadZips()[zip]; if (!z) return null;
  const feats = loadDistrictFeatures();
  let hit = feats.find(f => f.properties && f.properties.state === z.state && geoLib.geoContains(f, [z.lon, z.lat]));
  if (!hit) hit = feats.find(f => geoLib.geoContains(f, [z.lon, z.lat]));   // a zip centroid can sit just over a state line
  const district = hit ? String(hit.id) : (feats.filter(f => f.properties && f.properties.state === z.state).length === 1 ? `${z.state}-1` : null);
  return { zip, city: z.city, state: z.state, county: z.county, lat: z.lat, lon: z.lon, district };
}

// ---------------------------------------------------------------- predictions game
// Players register with a name; a token in their browser lets them edit their own entry.
// Entries lock at cfg.game.lockET (default 19:00 ET). Scored live from AP/NYT calls.
const GAME_FILE = path.join(ROOT, 'cache', 'game.json');
let game = { players: {} };
function loadGame() { try { game = JSON.parse(fs.readFileSync(GAME_FILE, 'utf8')); if (!game.players) game.players = {}; } catch { game = { players: {} }; } }
function saveGame() { try { fs.mkdirSync(path.join(ROOT, 'cache'), { recursive: true }); fs.writeFileSync(GAME_FILE, JSON.stringify(game)); } catch (e) { recordError('game', e.message); } }
function gameLockedNow(cfg) {
  const g = cfg.game || {}; if (g.locked === true) return true; if (g.locked === false) return false;
  const lockET = g.lockET || '19:00', day = g.lockDate || '2026-11-03';
  const nowET = new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' });   // "YYYY-MM-DD HH:MM:SS"
  return nowET >= `${day} ${lockET}:00`;
}
function allRacesById() {
  const out = {};
  for (const r of (state.nyt.house || []).concat(state.nyt.senate || [], state.nyt.governor || [])) out[raceKey(r)] = r;
  return out;
}
function scoreGame(cfg) {
  const races = allRacesById(), ctl = state.nyt.control || {};
  const lead = { house: { D: 0, R: 0 }, senate: { D: 0, R: 0 } };
  for (const r of state.nyt.house || []) { if (!r.winnerParty && r.totalVotes && (r.leaderParty === 'D' || r.leaderParty === 'R')) lead.house[r.leaderParty]++; }
  for (const r of state.nyt.senate || []) { if (!r.winnerParty && r.totalVotes && (r.leaderParty === 'D' || r.leaderParty === 'R')) lead.senate[r.leaderParty]++; }
  const h = ctl.house || {}, s = ctl.senate || {};
  const current = { houseD: h.seatsD || 0, houseR: h.seatsR || 0, houseDLead: (h.seatsD || 0) + lead.house.D, houseRLead: (h.seatsR || 0) + lead.house.R,
    senateD: s.seatsD || 0, senateR: s.seatsR || 0, senateDLead: (s.seatsD || 0) + lead.senate.D, senateRLead: (s.seatsR || 0) + lead.senate.R, houseCalled: h.called || 0, senateCalled: s.called || 0 };
  const players = Object.values(game.players).map(p => {
    let correct = 0, wrong = 0, pending = 0, leadingRight = 0, leadingWrong = 0; const detail = {};
    for (const [id, pick] of Object.entries(p.picks || {})) {
      const r = races[id]; if (!r) { detail[id] = 'unknown'; continue; }
      if (r.winnerParty) { if (r.winnerParty === pick) { correct++; detail[id] = 'correct'; } else { wrong++; detail[id] = 'wrong'; } }
      else if (r.totalVotes && (r.leaderParty === 'D' || r.leaderParty === 'R')) { pending++; if (r.leaderParty === pick) { leadingRight++; detail[id] = 'leading-right'; } else { leadingWrong++; detail[id] = 'leading-wrong'; } }
      else { pending++; detail[id] = 'pending'; }
    }
    const houseErr = p.houseD === null || p.houseD === undefined ? null : Math.abs(p.houseD - current.houseDLead);
    const senateErr = p.senateD === null || p.senateD === undefined ? null : Math.abs(p.senateD - current.senateDLead);
    return { id: p.id, name: p.name, home: p.home || null, houseD: p.houseD ?? null, senateD: p.senateD ?? null, gb: p.gb ?? null, picks: p.picks || {}, nPicks: Object.keys(p.picks || {}).length,
      correct, wrong, pending, leadingRight, leadingWrong, score: correct, accuracy: (correct + wrong) ? Math.round(correct / (correct + wrong) * 1000) / 10 : null,
      houseErr, senateErr, detail, updatedAt: p.updatedAt, createdAt: p.createdAt };
  });
  players.sort((a, b) => b.score - a.score || (a.wrong - b.wrong) || ((a.houseErr ?? 999) - (b.houseErr ?? 999)) || ((a.senateErr ?? 999) - (b.senateErr ?? 999)) || a.name.localeCompare(b.name));
  players.forEach((p, i) => p.rank = i + 1);
  return { locked: gameLockedNow(cfg), lockET: (cfg.game && cfg.game.lockET) || '19:00', current, players, n: players.length, updatedAt: Date.now() };
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; req.on('data', c => { data += c; if (data.length > 200000) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('bad JSON')); } });
    req.on('error', reject);
  });
}
const cleanName = s => String(s || '').replace(/[^\w .'\-]/g, '').trim().slice(0, 24);
function newToken() { return require('crypto').randomBytes(12).toString('hex'); }
async function handleGame(req, res, url) {
  const cfg = loadConfig();
  if (req.method === 'GET' && url.pathname === '/api/game') return send(res, 200, JSON.stringify(scoreGame(cfg)));
  if (url.pathname === '/api/game/remove') {   // host only: GET /api/game/remove?id=xxxx from this machine
    const ra = req.socket.remoteAddress || '';
    if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ra)) return send(res, 403, JSON.stringify({ error: 'host only' }));
    const id = url.searchParams.get('id'); const p = game.players[id];
    if (!p) return send(res, 404, JSON.stringify({ error: 'no such player' }));
    delete game.players[id]; saveGame();
    return send(res, 200, JSON.stringify({ ok: true, removed: p.name }));
  }

  if (req.method === 'POST' && url.pathname === '/api/game/register') {
    const body = await readBody(req); const name = cleanName(body.name);
    if (!name) return send(res, 400, JSON.stringify({ error: 'name required (letters, numbers, spaces)' }));
    if (Object.values(game.players).some(p => p.name.toLowerCase() === name.toLowerCase())) return send(res, 409, JSON.stringify({ error: 'that name is taken; pick another' }));
    if (Object.keys(game.players).length >= ((cfg.game && cfg.game.maxPlayers) || 200)) return send(res, 429, JSON.stringify({ error: 'player limit reached' }));
    if (gameLockedNow(cfg) && !(cfg.game && cfg.game.allowLate)) return send(res, 423, JSON.stringify({ error: 'entries are locked' }));
    const home = body.zip ? zipLookup(body.zip) : null;
    if (body.zip && !home) return send(res, 400, JSON.stringify({ error: 'zip code not recognized' }));
    if (!home && cfg.game && cfg.game.requireZip !== false) return send(res, 400, JSON.stringify({ error: 'home zip code required' }));
    const id = newToken().slice(0, 8), token = newToken();
    game.players[id] = { id, name, token, home, houseD: null, senateD: null, gb: null, picks: {}, createdAt: Date.now(), updatedAt: Date.now() };
    saveGame(); pushEvent({ type: 'game', id: 'game', text: `${name} joined the predictions game${home ? ` from ${home.city}, ${home.state}${home.district ? ' (' + home.district + ')' : ''}` : ''}` });
    return send(res, 200, JSON.stringify({ id, token, name, home }));
  }
  if (req.method === 'GET' && url.pathname === '/api/zip') {
    const h = zipLookup(url.searchParams.get('zip'));
    return send(res, h ? 200 : 404, JSON.stringify(h || { error: 'zip code not recognized' }));
  }
  if (req.method === 'POST' && url.pathname === '/api/game/entry') {
    const body = await readBody(req); const p = game.players[body.id];
    if (!p || p.token !== body.token) return send(res, 403, JSON.stringify({ error: 'not your entry' }));
    if (gameLockedNow(cfg) && !(cfg.game && cfg.game.allowLate)) return send(res, 423, JSON.stringify({ error: `entries locked at ${(cfg.game && cfg.game.lockET) || '19:00'} ET` }));
    const clampInt = (v, lo, hi) => { const n = parseInt(v, 10); return isNaN(n) ? null : Math.max(lo, Math.min(hi, n)); };
    if ('houseD' in body) p.houseD = clampInt(body.houseD, 0, 435);
    if ('senateD' in body) p.senateD = clampInt(body.senateD, 0, 100);
    if ('gb' in body) { const g = parseFloat(body.gb); p.gb = isNaN(g) ? null : Math.max(-30, Math.min(30, Math.round(g * 10) / 10)); }
    if (body.picks && typeof body.picks === 'object') {
      const races = allRacesById(), picks = {};
      for (const [id, v] of Object.entries(body.picks)) { if (races[id] && (v === 'D' || v === 'R')) picks[id] = v; }
      p.picks = picks;
    }
    if (body.name) { const nm = cleanName(body.name); if (nm && !Object.values(game.players).some(q => q.id !== p.id && q.name.toLowerCase() === nm.toLowerCase())) p.name = nm; }
    if (body.zip) { const h = zipLookup(body.zip); if (!h) return send(res, 400, JSON.stringify({ error: 'zip code not recognized' })); p.home = h; }
    p.updatedAt = Date.now(); saveGame();
    return send(res, 200, JSON.stringify({ ok: true, player: { id: p.id, name: p.name, home: p.home || null, houseD: p.houseD, senateD: p.senateD, gb: p.gb, picks: p.picks, updatedAt: p.updatedAt } }));
  }
  if (req.method === 'GET' && url.pathname === '/api/game/me') {
    const p = game.players[url.searchParams.get('id')];
    if (!p || p.token !== url.searchParams.get('token')) return send(res, 403, JSON.stringify({ error: 'not your entry' }));
    return send(res, 200, JSON.stringify({ id: p.id, name: p.name, home: p.home || null, houseD: p.houseD, senateD: p.senateD, gb: p.gb, picks: p.picks, updatedAt: p.updatedAt }));
  }
  return send(res, 404, JSON.stringify({ error: 'no such game endpoint' }));
}

// ---------------------------------------------------------------- history
function pushHistory(cfg) {
  const kH = state.kalshi.control.house && state.kalshi.control.house.pD;
  const pH = state.polymarket.control.house && state.polymarket.control.house.pD;
  const kS = state.kalshi.control.senate && state.kalshi.control.senate.pD;
  const pS = state.polymarket.control.senate && state.polymarket.control.senate.pD;
  state.history.push({ t: Date.now(), kH: kH ?? null, pH: pH ?? null, kS: kS ?? null, pS: pS ?? null });
  const keepMs = (cfg.historyHours || 2) * 3600 * 1000;
  const cutoff = Date.now() - keepMs;
  while (state.history.length && state.history[0].t < cutoff) state.history.shift();
}

// ---------------------------------------------------------------- loops
let marketTimer = null, nytTimer = null;
async function marketTick() {
  const cfg = loadConfig();
  await Promise.all([
    pollKalshi(cfg).catch(e => recordError('kalshi', e.message)),
    pollPolymarket(cfg).catch(e => recordError('polymarket', e.message)),
    pollExtraMarkets(cfg).catch(e => recordError('markets', e.message)),
  ]);
  pushHistory(cfg);
  try { pushRaceHistory(cfg); } catch (e) { recordError('history', e.message); }
  state.updatedAt = Date.now();
  clearTimeout(marketTimer);
  marketTimer = setTimeout(marketTick, Math.max(5000, cfg.pollIntervalMs || 30000));
}
async function nytTick() {
  const cfg = loadConfig();
  await pollNYT(cfg).catch(e => recordError('nyt', e.message));
  state.updatedAt = Date.now();
  // re-aggregate polls against the fresh candidate index (cheap, ~50 ms)
  if (pollsMod && rawPolls && state.nyt.index) {
    try { const keepT = state.polls && state.polls.updatedAt; state.polls = pollsMod.aggregatePolls(rawPolls, state.nyt.index, { now: Date.now() }); state.polls.updatedAt = keepT || Date.now(); }
    catch (e) { recordError('polls', 'aggregate: ' + e.message); }
  }
  clearTimeout(nytTimer);
  nytTimer = setTimeout(nytTick, Math.max(15000, cfg.nytIntervalMs || 60000));
}
let pollsTimer = null;
async function pollsTick() {
  const cfg = loadConfig();
  await pollVoteHub(cfg).catch(e => recordError('polls', e.message));
  clearTimeout(pollsTimer);
  pollsTimer = setTimeout(pollsTick, Math.max(60000, cfg.pollsIntervalMs || 600000));
}

// ---------------------------------------------------------------- http
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/game') || url.pathname === '/api/zip') { handleGame(req, res, url).catch(e => send(res, 400, JSON.stringify({ error: e.message }))); return; }
  if (url.pathname === '/api/homes') {
    // the guests' hometowns for the table's "Hometowns" dataset (no tokens, no picks)
    return send(res, 200, JSON.stringify({ players: Object.values(game.players).filter(p => p.home).map(p => ({ id: p.id, name: p.name, home: p.home })) }));
  }
  if (url.pathname === '/api/state') {
    const cfg = loadConfig();
    return send(res, 200, JSON.stringify({
      now: Date.now(),
      config: { races: cfg.races, control: cfg.control, embeds: cfg.embeds, links: cfg.links, pollIntervalMs: cfg.pollIntervalMs, nytIntervalMs: cfg.nytIntervalMs, historyHours: cfg.historyHours, marginPerspective: cfg.marginPerspective },
      kalshi: { updatedAt: state.kalshi.updatedAt, control: state.kalshi.control, races: state.kalshi.races },
      polymarket: { updatedAt: state.polymarket.updatedAt, control: state.polymarket.control, races: state.polymarket.races },
      nyt: { updatedAt: state.nyt.updatedAt, resultsUpdatedAt: state.nyt.resultsUpdatedAt, control: state.nyt.control, races: state.nyt.races, national: state.nyt.national || null, pollClosing: state.nyt.pollClosing || [] },
      polls: state.polls || null,
      history: state.history,
      events: state.events.slice(0, 150),
      eventSeq,
      snapshots: Object.values(state.snapshots).map(s => ({ label: s.label, t: s.t })),
      errors: state.errors,
    }));
  }
  if (url.pathname === '/api/events') {
    const since = Number(url.searchParams.get('since') || 0);
    return send(res, 200, JSON.stringify({ seq: eventSeq, events: state.events.filter(e => e.seq > since) }));
  }
  if (url.pathname === '/api/history') {
    return send(res, 200, JSON.stringify({ intervalMs: loadConfig().pollIntervalMs || 30000, control: state.history, races: state.raceHistory }));
  }
  if (url.pathname === '/api/snapshots') {
    return send(res, 200, JSON.stringify({ list: Object.values(state.snapshots).map(s => ({ label: s.label, t: s.t })), snapshots: state.snapshots }));
  }
  if (url.pathname === '/api/snapshot') {
    const label = (url.searchParams.get('label') || etHHMM()).slice(0, 40);
    return send(res, 200, JSON.stringify({ ok: true, label, t: takeSnapshot(label).t }));
  }
  if (url.pathname === '/api/seats') {
    // Full chamber lists for the seat view and map; fetched less often by the page.
    return send(res, 200, JSON.stringify({ updatedAt: state.nyt.updatedAt, house: state.nyt.house, senate: state.nyt.senate, governor: state.nyt.governor || [], markets: state.markets || {}, marketsUpdatedAt: state.marketsUpdatedAt || null }));
  }
  if (url.pathname === '/api/spending') {
    return send(res, 200, JSON.stringify(state.spending || null));
  }
  // named layout setups: the page's localStorage preferences saved server-side so another device can load them (?setup=name)
  if (url.pathname === '/api/setup') {
    const name = String(url.searchParams.get('name') || '').replace(/[^\w-]/g, '').slice(0, 32);
    const file = path.join(ROOT, 'cache', 'setups.json');
    let all = {}; try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (req.method === 'POST') {
      if (!name) return send(res, 400, '{"error":"name required"}');
      readBody(req).then(body => { all[name] = { t: Date.now(), prefs: body.prefs || {} }; fs.mkdirSync(path.join(ROOT, 'cache'), { recursive: true }); fs.writeFileSync(file, JSON.stringify(all)); send(res, 200, JSON.stringify({ ok: true, name })); }).catch(e => send(res, 400, JSON.stringify({ error: e.message })));
      return;
    }
    if (name) return send(res, all[name] ? 200 : 404, JSON.stringify(all[name] || { error: 'no such setup' }));
    return send(res, 200, JSON.stringify({ setups: Object.keys(all) }));
  }
  if (url.pathname === '/api/refresh') { marketTick(); nytTick(); pollsTick(); return send(res, 200, '{"ok":true}'); }

  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
  const abs = path.join(PUBLIC, file);
  if (!abs.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(abs, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, data, MIME[path.extname(abs)] || 'application/octet-stream');
  });
});

const cfg0 = loadConfig();
server.listen(cfg0.port || 3000, () => {
  log(`dashboard at http://localhost:${cfg0.port || 3000}`);
  marketTick();
  nytTick().then(() => { pollsTick(); pollExtraMarkets(loadConfig()).catch(e => recordError('markets', e.message)); });
  loadSpendingOnce(cfg0);
  setInterval(() => loadSpendingOnce(loadConfig()), 6 * 3600e3);
  loadSnapshots();
  setInterval(snapshotTick, 20000);
  loadGame();
});
