'use strict';
// VoteHub poll fetch + aggregation for the election-night dashboard.
// No dependencies. aggregatePolls is pure and never throws.

const STATE_CODES = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA',
  'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE', 'district of columbia': 'DC',
  'washington dc': 'DC', 'washington d.c.': 'DC', 'florida': 'FL', 'georgia': 'GA',
  'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA',
  'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', 'tennessee': 'TN',
  'texas': 'TX', 'utah': 'UT', 'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA',
  'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY',
};

const DAY_MS = 86400000;
const POP_RANK = { lv: 0, rv: 1, v: 2, a: 3 };

async function fetchPolls(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(45000),
    headers: { 'user-agent': 'Mozilla/5.0 election-night-dashboard' },
  });
  if (!res.ok) throw new Error(`VoteHub polls HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('VoteHub polls: expected array');
  return data;
}

// ---------- helpers ----------
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const str = (x) => (typeof x === 'string' ? x : x == null ? '' : String(x));
const num = (x) => {
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};

function endMs(p) {
  const e = str(p && p.end_date).trim();
  if (!e) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(e) ? e + 'T12:00:00Z' : e);
  return Number.isFinite(t) ? t : null;
}

function answers(p) {
  const out = [];
  const a = p && Array.isArray(p.answers) ? p.answers : [];
  for (const x of a) {
    if (!x || typeof x !== 'object') continue;
    const choice = str(x.choice).trim();
    const pct = num(x.pct);
    if (choice && pct != null) out.push({ choice, pct });
  }
  return out;
}

function pctOf(p, name) {
  const want = name.toLowerCase();
  for (const a of answers(p)) if (a.choice.toLowerCase() === want) return a.pct;
  return null;
}

function popRank(p) {
  const r = POP_RANK[str(p.population).toLowerCase()];
  return r == null ? 9 : r;
}

// Sort newest first: end_date desc, then created_at desc.
function byRecent(a, b) {
  if (b._end !== a._end) return b._end - a._end;
  return str(b.poll.created_at).localeCompare(str(a.poll.created_at));
}

// VoteHub often lists one survey several times (lv / rv / adults). Collapse to one
// observation per survey, preferring lv > rv > v > a.
function dedupe(items, keyFn) {
  const best = new Map();
  for (const it of items) {
    let k;
    try { k = keyFn(it); } catch { k = Math.random(); }
    const cur = best.get(k);
    if (!cur || popRank(it.poll) < popRank(cur.poll)) best.set(k, it);
  }
  return [...best.values()];
}

const surveyKey = (it) => [str(it.poll.pollster), str(it.poll.start_date), str(it.poll.end_date)].join('|');

// Select window: try each width in turn until at least `min` items; returns { items, days }.
function windowed(items, now, widths, min) {
  let sel = [], days = widths[widths.length - 1];
  for (const w of widths) {
    sel = items.filter((it) => now - it._end <= w * DAY_MS);
    days = w;
    if (sel.length >= min) break;
  }
  return { items: sel.sort(byRecent), days };
}

function partisanFlag(p) {
  const v = p.partisan;
  if (v == null || v === '' || v === false) return null;
  return str(v);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function norm(s) {
  return str(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}
function containsWord(hay, needle) {
  if (!needle) return false;
  return new RegExp('(^|[^a-z0-9])' + escapeRe(needle) + '($|[^a-z0-9])').test(hay);
}

// Levenshtein distance <= 1 (handles misspellings like "Healy" vs "Healey").
function within1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// Score how well a poll choice matches a candidate (0 = no match).
//   3: full name equals / contains the choice, or choice contains full name
//   2: choice contains candidate last name as a word
//   1: choice's last word equals, or is within one edit of, the last name's last word
function matchScore(c, cand) {
  const last = norm(cand.last);
  const full = norm(cand.name);
  if (full && c.length >= 3 && (containsWord(full, c) || containsWord(c, full))) return 3;
  if (last.length >= 2 && containsWord(c, last)) return 2;
  // Compare final words, e.g. "Jenny Honeycutt" vs last name "Costa Honeycutt".
  const cw = c.split(' ');
  const cl = cw[cw.length - 1];
  const lw = last.split(' ');
  const ll = lw[lw.length - 1];
  if (ll.length >= 3 && cl === ll) return 1;
  if (ll.length >= 5 && cl.length >= 5 && within1(cl, ll)) return 1;
  return 0;
}

// Map a poll's choices to D/R using candidate list. Returns { dem, rep } or null.
function mapPoll(ans, cands) {
  if (!Array.isArray(cands) || !cands.length) return null;
  let dem = null, rep = null;
  for (const a of ans) {
    const c = norm(a.choice);
    if (c.length < 2) continue;
    // Keep only the best-scoring candidates; if they disagree on party, skip choice.
    let best = 0;
    let parties = new Set();
    for (const cand of cands) {
      if (!cand || typeof cand !== 'object') continue;
      const sc = matchScore(c, cand);
      if (sc === 0 || sc < best) continue;
      if (sc > best) { best = sc; parties = new Set(); }
      parties.add(cand.party);
    }
    if (parties.size !== 1) continue; // unmatched or ambiguous
    const party = [...parties][0];
    if (party === 'D') dem = dem == null ? a.pct : Math.max(dem, a.pct);
    else if (party === 'R') rep = rep == null ? a.pct : Math.max(rep, a.pct);
  }
  return dem != null && rep != null ? { dem, rep } : null;
}

function houseKey(p) {
  const tryParse = (s) => {
    const m = /\b([A-Za-z]{2})-(\d{1,2}|AL)\b/.exec(str(s));
    if (!m) return null;
    const n = m[2].toUpperCase() === 'AL' ? 1 : parseInt(m[2], 10);
    if (!Number.isFinite(n)) return null;
    return `${m[1].toUpperCase()}-${n === 0 ? 1 : n}`;
  };
  return tryParse(p.seat_name) || tryParse(p.subject);
}

function stateKey(subject) {
  const m = /^\s*(\d{4})\s+(.+?)\s*$/.exec(str(subject));
  const name = (m ? m[2] : str(subject)).toLowerCase().trim();
  return STATE_CODES[name] || null;
}

function isPrimarySubject(subject) {
  const words = str(subject).trim().split(/\s+/);
  const last = (words[words.length - 1] || '').toLowerCase();
  return last === 'democratic' || last === 'republican';
}

// ---------- sections ----------
function aggGeneric(items, now) {
  const obs = [];
  for (const it of items) {
    try {
      const dem = pctOf(it.poll, 'Dem'), rep = pctOf(it.poll, 'Rep');
      if (dem == null || rep == null) continue;
      obs.push({ ...it, dem, rep });
    } catch { /* skip */ }
  }
  const { items: sel, days } = windowed(dedupe(obs, surveyKey), now, [21, 45], 3);
  if (!sel.length) return { margin: null, n: 0, windowDays: days, latest: null, polls: [] };
  const dem = mean(sel.map((o) => o.dem)), rep = mean(sel.map((o) => o.rep));
  const row = (o) => ({ pollster: str(o.poll.pollster) || null, endDate: str(o.poll.end_date), dem: r1(o.dem), rep: r1(o.rep), margin: r1(o.dem - o.rep) });
  return {
    margin: r1(dem - rep),
    n: sel.length,
    windowDays: days,
    latest: row(sel[0]),
    polls: sel.slice(0, 12).map((o) => ({
      ...row(o),
      population: o.poll.population == null ? null : str(o.poll.population),
      sampleSize: num(o.poll.sample_size),
      internal: o.poll.internal === true,
      partisan: partisanFlag(o.poll),
    })),
  };
}

function aggApproval(items, now) {
  const obs = [];
  for (const it of items) {
    try {
      if (norm(it.poll.subject) !== 'donald trump') continue;
      const approve = pctOf(it.poll, 'Approve'), disapprove = pctOf(it.poll, 'Disapprove');
      if (approve == null || disapprove == null) continue;
      obs.push({ ...it, approve, disapprove });
    } catch { /* skip */ }
  }
  // Spec window is 21 days; widen (45, then 90) when fewer than 3 polls so the
  // panel is not blank during polling droughts. windowDays reports what was used.
  const { items: sel, days } = windowed(dedupe(obs, surveyKey), now, [21, 45, 90], 3);
  if (!sel.length) return { approve: null, disapprove: null, net: null, n: 0, windowDays: days, latest: null };
  const ap = mean(sel.map((o) => o.approve)), dis = mean(sel.map((o) => o.disapprove));
  const l = sel[0];
  return {
    approve: r1(ap),
    disapprove: r1(dis),
    net: r1(ap - dis),
    n: sel.length,
    windowDays: days,
    latest: { pollster: str(l.poll.pollster) || null, endDate: str(l.poll.end_date), approve: r1(l.approve), disapprove: r1(l.disapprove) },
  };
}

// groups: Map key -> { subjects:Set, items:[] }; cands: index[key]
function aggRaces(groups, candIndex, now, unmapped) {
  const out = {};
  for (const [key, g] of groups) {
    try {
      // Only consider polls within the widest window.
      const recent = g.items.filter((it) => now - it._end <= 90 * DAY_MS);
      if (!recent.length) continue;
      const cands = candIndex && typeof candIndex === 'object' ? candIndex[key] : null;
      const mapped = [];
      for (const it of recent) {
        try {
          const m = mapPoll(answers(it.poll), cands);
          if (m) mapped.push({ ...it, dem: m.dem, rep: m.rep });
        } catch { /* skip */ }
      }
      if (!mapped.length) {
        for (const s of g.subjects) unmapped.add(s);
        continue;
      }
      // One observation per survey (dedupe population variants / alternate matchups).
      const { items: sel, days } = windowed(dedupe(mapped, surveyKey), now, [45, 90], 2);
      if (!sel.length) continue;
      const dem = mean(sel.map((o) => o.dem)), rep = mean(sel.map((o) => o.rep));
      out[key] = {
        margin: r1(dem - rep),
        n: sel.length,
        windowDays: days,
        latestEnd: str(sel[0].poll.end_date),
        dem: r1(dem),
        rep: r1(rep),
        polls: sel.slice(0, 8).map((o) => ({
          pollster: str(o.poll.pollster) || null,
          endDate: str(o.poll.end_date),
          dem: r1(o.dem),
          rep: r1(o.rep),
          margin: r1(o.dem - o.rep),
          population: o.poll.population == null ? null : str(o.poll.population),
          sampleSize: num(o.poll.sample_size),
        })),
      };
    } catch { /* skip race */ }
  }
  return out;
}

function aggPrimary(items, now, party) {
  const want = party.toLowerCase();
  const recent = dedupe(
    items.filter((it) => {
      const w = norm(it.poll.subject).split(' ');
      return w[w.length - 1] === want && now - it._end <= 60 * DAY_MS;
    }),
    surveyKey
  );
  const acc = new Map();
  for (const it of recent) {
    try {
      const seen = new Set();
      for (const a of answers(it.poll)) {
        const k = a.choice.replace(/\s+/g, ' ');
        const lk = k.toLowerCase();
        if (seen.has(lk)) continue;
        seen.add(lk);
        if (/^(undecided|other|someone else|not sure|none|don'?t know|refused)/i.test(k)) continue;
        const e = acc.get(lk) || { name: k, vals: [] };
        e.vals.push(a.pct);
        acc.set(lk, e);
      }
    } catch { /* skip */ }
  }
  return [...acc.values()]
    .map((e) => ({ name: e.name, pct: r1(mean(e.vals)), n: e.vals.length }))
    .sort((a, b) => b.pct - a.pct || b.n - a.n)
    .slice(0, 8);
}

function aggregatePolls(polls, nytIndex, opts) {
  const now = num(opts && opts.now) != null ? num(opts && opts.now) : Date.now();
  const idx = nytIndex && typeof nytIndex === 'object' ? nytIndex : {};
  const result = {
    updatedAt: now,
    genericBallot: { margin: null, n: 0, windowDays: 21, latest: null, polls: [] },
    trumpApproval: { approve: null, disapprove: null, net: null, n: 0, windowDays: 21, latest: null },
    senate: {},
    governor: {},
    house: {},
    primary2028: { dem: [], rep: [] },
    skipped: { unmappedRaces: [] },
  };
  const list = Array.isArray(polls) ? polls : [];

  const generic = [], approval = [], primary = [];
  const raceGroups = { senate: new Map(), governor: new Map(), house: new Map() };
  const addRace = (kind, key, it) => {
    const m = raceGroups[kind];
    if (!m.has(key)) m.set(key, { subjects: new Set(), items: [] });
    const g = m.get(key);
    g.subjects.add(str(it.poll.subject) || key);
    g.items.push(it);
  };

  for (const p of list) {
    try {
      if (!p || typeof p !== 'object') continue;
      if (p.internal === true) continue;
      const _end = endMs(p);
      if (_end == null) continue;
      const it = { poll: p, _end };
      switch (p.poll_type) {
        case 'generic-ballot': generic.push(it); break;
        case 'approval': approval.push(it); break;
        case 'presidential-primary': primary.push(it); break;
        case 'us-senator':
        case 'governor': {
          if (isPrimarySubject(p.subject)) break;
          const st = stateKey(p.subject);
          if (!st) break;
          addRace(p.poll_type === 'us-senator' ? 'senate' : 'governor', st, it);
          break;
        }
        case 'us-representative': {
          if (isPrimarySubject(p.subject)) break;
          const k = houseKey(p);
          if (k) addRace('house', k, it);
          break;
        }
        default: break;
      }
    } catch { /* bad record */ }
  }

  const unmapped = new Set();
  try { result.genericBallot = aggGeneric(generic, now); } catch { /* keep default */ }
  try { result.trumpApproval = aggApproval(approval, now); } catch { /* keep default */ }
  try { result.senate = aggRaces(raceGroups.senate, idx.senate, now, unmapped); } catch { /* */ }
  try { result.governor = aggRaces(raceGroups.governor, idx.governor, now, unmapped); } catch { /* */ }
  try { result.house = aggRaces(raceGroups.house, idx.house, now, unmapped); } catch { /* */ }
  try { result.primary2028 = { dem: aggPrimary(primary, now, 'Democratic'), rep: aggPrimary(primary, now, 'Republican') }; } catch { /* */ }
  result.skipped.unmappedRaces = [...unmapped].sort();
  return result;
}

module.exports = { fetchPolls, aggregatePolls, STATE_CODES };
