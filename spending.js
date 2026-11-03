'use strict';
// FEC 2026-cycle spending aggregator (no npm deps).
// Sources: weball26.zip (candidate committee totals) + independent_expenditure_2026.csv.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const WEBALL_URL = 'https://www.fec.gov/files/bulk-downloads/2026/weball26.zip';
const IE_URL = 'https://www.fec.gov/files/bulk-downloads/2026/independent_expenditure_2026.csv';

// ---------- minimal ZIP reader (first entry only) ----------
function unzipFirst(buf) {
  // End of central directory: signature 0x06054b50, >= 22 bytes, may be followed by a comment (<= 65535).
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const entries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries < 1) throw new Error('zip: no entries');
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('zip: bad central directory signature');
  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const uncompSize = buf.readUInt32LE(cdOffset + 24);
  const nameLen = buf.readUInt16LE(cdOffset + 28);
  const localOff = buf.readUInt32LE(cdOffset + 42);
  const name = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen);
  if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('zip: bad local header signature');
  // Sizes in the local header may be zero (data descriptor), so take them from the central directory.
  const lNameLen = buf.readUInt16LE(localOff + 26);
  const lExtraLen = buf.readUInt16LE(localOff + 28);
  const start = localOff + 30 + lNameLen + lExtraLen;
  const data = buf.subarray(start, start + compSize);
  let out;
  if (method === 0) out = Buffer.from(data);
  else if (method === 8) out = zlib.inflateRawSync(data);
  else throw new Error('zip: unsupported compression method ' + method);
  if (uncompSize !== 0xffffffff && out.length !== uncompSize) {
    throw new Error(`zip: size mismatch for ${name} (${out.length} != ${uncompSize})`);
  }
  return { name, data: out };
}

// ---------- CSV parser (RFC 4180-ish, char scanner) ----------
// Calls onRow(fieldsArray) for each record. Handles quoted fields with embedded
// commas, CR/LF and doubled quotes ("").
function parseCsv(text, onRow) {
  const n = text.length;
  let i = 0, field = '', row = [];
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 34 /* " */ && field === '') {
      // quoted field
      i++;
      let start = i, chunks = '';
      for (;;) {
        const q = text.indexOf('"', i);
        if (q < 0) { chunks += text.slice(start); i = n; break; }
        if (text.charCodeAt(q + 1) === 34) { chunks += text.slice(start, q + 1); i = q + 2; start = i; continue; }
        chunks += text.slice(start, q); i = q + 1; break;
      }
      field = chunks;
      // consume any junk until delimiter (lenient)
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 44 || d === 10 || d === 13) break;
        field += text[i++];
      }
      continue;
    }
    if (c === 44 /* , */) { row.push(field); field = ''; i++; continue; }
    if (c === 13 || c === 10) {
      row.push(field); field = '';
      if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
      i++;
      if (!(row.length === 1 && row[0] === '')) onRow(row);
      row = [];
      continue;
    }
    // unquoted run
    let j = i;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (d === 44 || d === 10 || d === 13) break;
      j++;
    }
    field += text.slice(i, j); i = j;
  }
  if (field !== '' || row.length) { row.push(field); onRow(row); }
}

// ---------- helpers ----------
function bucket() { return { candD: 0, candR: 0, candO: 0, ieD: 0, ieR: 0, ieO: 0, totalD: 0, totalR: 0, total: 0 }; }
function finalize(b) {
  for (const k of ['candD', 'candR', 'candO', 'ieD', 'ieR', 'ieO']) b[k] = Math.round(b[k]);
  b.totalD = b.candD + b.ieD;
  b.totalR = b.candR + b.ieR;
  b.total = b.totalD + b.totalR + b.candO + b.ieO;
  return b;
}
function partyCode(p) {
  p = String(p || '').trim().toUpperCase();
  if (p === 'DEM' || p === 'DFL') return 'D';
  if (p === 'REP' || p === 'GOP') return 'R';
  return 'O';
}
function partyFromText(s) {
  s = String(s || '').toUpperCase();
  if (s.includes('DEMOCRAT')) return 'D';
  if (s.includes('REPUBLICAN')) return 'R';
  return 'O';
}
function num(s) {
  const v = parseFloat(String(s || '').replace(/[$,\s]/g, ''));
  return Number.isFinite(v) ? v : 0;
}
// Keys for matching an IE row's candidate to a weball candidate by surname.
function nameKey(off, st, dis, name) {
  const last = String(name || '').split(',')[0].trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (!last || !off || !st) return null;
  const d = off === 'H' ? (parseInt(dis, 10) || 0) : '';
  return [`${off}|${st}|${d}|${last}`, `${off}|${st}||${last}`];
}
function districtKey(st, dis) {
  let d = parseInt(dis, 10);
  if (!Number.isFinite(d)) return null;
  if (d === 0) d = 1; // at-large
  return `${st}-${d}`;
}

// ---------- aggregation ----------
function aggregate(weballText, ieCsvText) {
  const national = { H: bucket(), S: bucket(), all: bucket() };
  const states = {};
  const districts = {};
  const stateOf = (st) => (states[st] || (states[st] = { H: bucket(), S: bucket(), all: bucket() }));

  // add value v to field f across national/state/district for office off
  function add(off, st, dis, field, v) {
    if (!v) return;
    national.all[field] += v;
    if (off === 'H' || off === 'S') national[off][field] += v;
    if (st && /^[A-Z]{2}$/.test(st)) {
      const s = stateOf(st);
      s.all[field] += v;
      if (off === 'H' || off === 'S') s[off][field] += v;
      if (off === 'H') {
        const k = districtKey(st, dis);
        if (k) (districts[k] || (districts[k] = bucket()))[field] += v;
      }
    }
  }

  // --- weball: candidate committee disbursements ---
  let weballRows = 0, weballSkipped = 0;
  const cands = [];
  const candParty = new Map(); // CAND_ID -> D/R/O
  const byName = new Map();    // office|state|district|LASTNAME (and office|state||LASTNAME) -> Set(party)
  for (const line of String(weballText).split(/\r?\n/)) {
    if (!line) continue;
    const f = line.split('|');
    if (f.length < 20) continue;
    weballRows++;
    const id = f[0].trim();
    const off = id.charAt(0);
    const party = partyCode(f[4]);
    const disb = num(f[7]);
    const st = f[18].trim().toUpperCase();
    const dis = f[19].trim();
    // Remember party for IE rows that leave cand_pty_aff blank (see below).
    candParty.set(id, party);
    const nk = nameKey(off, st, dis, f[1]);
    if (nk) { (byName.get(nk[0]) || byName.set(nk[0], new Set()).get(nk[0])).add(party);
      (byName.get(nk[1]) || byName.set(nk[1], new Set()).get(nk[1])).add(party); }
    // Data-quality guard: a committee cannot spend far more than it raised plus
    // its starting cash, and cannot end with large negative cash (e.g. a 2026
    // row with $0 receipts, $776M disbursed and -$776M cash on hand).
    const avail = num(f[5]) + num(f[9]);
    if (num(f[10]) < -250e3 || disb > avail * 1.1 + 250e3) { weballSkipped++; continue; }
    add(off, st, dis, 'cand' + party, disb);
    if (disb > 0) {
      cands.push({
        name: f[1].trim(), party, office: off, state: st,
        district: off === 'H' ? (parseInt(dis, 10) || 1) : null,
        disb: Math.round(disb),
      });
    }
  }
  cands.sort((a, b) => b.disb - a.disb);

  // --- independent expenditures ---
  // Amendments: every amended row (amndt_ind A1/A2/...) carries prev_file_num,
  // the filing it amends. An FEC amended report replaces the prior report in
  // full, so we drop every row whose file_num is referenced as some row's
  // prev_file_num (that handles A2 -> A1 -> N chains too). No other dedupe is
  // done (tran_id is reused across filings by some filers, so it is not a
  // reliable key). Two-pass: parse all rows, then aggregate survivors.
  // Junk guard: single rows above IE_MAX_ROW ($50M) are dropped; the file has
  // bogus self-filed entries of $0.5B-$9B, while the largest real rows are <$30M.
  const IE_MAX_ROW = 50e6;
  let ieRows = 0, ieSuperseded = 0, ieJunk = 0, iePartyFilled = 0, header = null, idx = null;
  const spenders = new Map();
  const ieAll = [];
  parseCsv(String(ieCsvText), (r) => {
    if (!header) {
      header = r.map((h) => h.trim().toLowerCase());
      const at = (name) => header.indexOf(name);
      idx = {
        off: at('can_office'), st: at('can_office_state'), dis: at('can_office_dis'),
        pty: at('cand_pty_aff'), amt: at('exp_amo'), so: at('sup_opp'), spe: at('spe_nam'),
        file: at('file_num'), prev: at('prev_file_num'),
        cid: at('cand_id'), cname: at('cand_name'),
      };
      if (idx.amt < 0 || idx.so < 0) throw new Error('IE CSV: unexpected header');
      return;
    }
    if (r.length < 10) return;
    ieRows++;
    ieAll.push(r);
  });
  const superseded = new Set();
  if (idx && idx.prev >= 0) for (const r of ieAll) { const p = (r[idx.prev] || '').trim(); if (p) superseded.add(p); }
  for (const r of ieAll) {
    if (idx.file >= 0 && superseded.has((r[idx.file] || '').trim())) { ieSuperseded++; continue; }
    const amt = num(r[idx.amt]);
    if (!amt) continue;
    if (Math.abs(amt) > IE_MAX_ROW) { ieJunk++; continue; }
    const off = String(r[idx.off] || '').trim().toUpperCase();
    const st = String(r[idx.st] || '').trim().toUpperCase();
    const dis = String(r[idx.dis] || '').trim();
    let p = partyFromText(r[idx.pty]);
    // ~5k rows (~$400M) have a blank cand_pty_aff. Fill party from weball:
    // first by cand_id, else by unique surname match on office/state/district,
    // else office/state. Unresolved rows stay "O".
    if (!String(r[idx.pty] || '').trim()) {
      const cid = String(r[idx.cid] || '').trim();
      let q = cid && candParty.get(cid);
      if (!q) {
        const nk = nameKey(off, st, dis, r[idx.cname]);
        if (nk) for (const k of nk) { const set = byName.get(k); if (set && set.size === 1) { q = [...set][0]; break; } }
      }
      if (q) { p = q; iePartyFilled++; }
    }
    const so = String(r[idx.so] || '').trim().toUpperCase();
    let side = 'O';
    if ((so === 'S' && p === 'D') || (so === 'O' && p === 'R')) side = 'D';
    else if ((so === 'S' && p === 'R') || (so === 'O' && p === 'D')) side = 'R';
    add(off, st, dis, 'ie' + side, amt);
    const name = String(r[idx.spe] || '').trim() || '(unknown)';
    let s = spenders.get(name);
    if (!s) spenders.set(name, (s = { name, total: 0, d: 0, r: 0 }));
    s.total += amt;
    if (side === 'D') s.d += amt; else if (side === 'R') s.r += amt;
  }

  finalize(national.H); finalize(national.S); finalize(national.all);
  for (const st of Object.keys(states)) { finalize(states[st].H); finalize(states[st].S); finalize(states[st].all); }
  for (const k of Object.keys(districts)) finalize(districts[k]);

  const topSpenders = [...spenders.values()]
    .map((s) => ({ name: s.name, total: Math.round(s.total), d: Math.round(s.d), r: Math.round(s.r) }))
    .sort((a, b) => b.total - a.total).slice(0, 25);

  return {
    updatedAt: Date.now(),
    source: {
      weballBytes: Buffer.byteLength(String(weballText)),
      ieBytes: Buffer.byteLength(String(ieCsvText)),
      ieRows, weballRows,
      ieSuperseded, ieJunk, iePartyFilled, weballSkipped,
    },
    national, states, districts,
    topCandidates: cands.slice(0, 25),
    topSpenders,
  };
}

// ---------- loader with cache ----------
async function fetchBuf(url, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (election-night spending.js)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return Buffer.from(await res.arrayBuffer());
  } finally { clearTimeout(t); }
}

function readCache(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.national && j.states) return j;
  } catch (_) {}
  return null;
}

async function loadSpending(opts = {}) {
  const {
    cacheFile = null, weballUrl = WEBALL_URL, ieUrl = IE_URL,
    maxAgeMs = 6 * 3600e3, log = () => {}, timeoutMs = 120e3,
  } = opts;
  const cached = cacheFile ? readCache(cacheFile) : null;
  if (cached && Date.now() - (cached.updatedAt || 0) < maxAgeMs) {
    log(`spending: using fresh cache (${Math.round((Date.now() - cached.updatedAt) / 60e3)} min old)`);
    return cached;
  }
  try {
    log('spending: fetching FEC bulk files');
    const [zipBuf, ieBuf] = await Promise.all([fetchBuf(weballUrl, timeoutMs), fetchBuf(ieUrl, timeoutMs)]);
    const weball = unzipFirst(zipBuf).data.toString('latin1');
    const ie = ieBuf.toString('utf8');
    const result = aggregate(weball, ie);
    log(`spending: built (${result.source.weballRows} candidates, ${result.source.ieRows} IE rows)`);
    if (cacheFile) {
      try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        const tmp = cacheFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(result));
        fs.renameSync(tmp, cacheFile);
      } catch (e) { log('spending: cache write failed: ' + e.message); }
    }
    return result;
  } catch (e) {
    if (cached) { log('spending: fetch/build failed, using stale cache: ' + e.message); return cached; }
    throw e;
  }
}

module.exports = { loadSpending, aggregate, unzipFirst, parseCsv, WEBALL_URL, IE_URL };
