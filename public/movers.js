// Odds movers view: biggest market moves per race over a chosen window.
// Exposes window.renderMovers(container) and window.moversRefresh(force).
// Reads page globals S, SEATS, HOUSE_BY_ID, RATING_LABEL, esc, store (all optional; nothing throws without them).
(function () {
  'use strict';
  const MV = { history: null, snaps: null, events: null, fetchedAt: 0, inflight: null, container: null, showAll: false, precall: {}, calls: {} };
  const REFRESH_MS = 30e3, PRE_CALL_MS = 30 * 60e3, PRE_CALL_PTS = 5;
  const WINDOWS = [['15', '15m'], ['30', '30m'], ['60', '60m'], ['120', '2h'], ['6pm', 'vs 6pm'], ['midnight', 'vs midnight']];
  const SOURCES = [['avg', 'Avg'], ['k', 'Kalshi'], ['p', 'Poly']];

  // ---- safe access to page globals (declared with let/const in index.html, so not on window)
  const G = {
    S() { try { return typeof S !== 'undefined' ? S : null; } catch (e) { return null; } },
    SEATS() { try { return typeof SEATS !== 'undefined' ? SEATS : null; } catch (e) { return null; } },
    HOUSE() { try { return typeof HOUSE_BY_ID !== 'undefined' ? HOUSE_BY_ID || {} : {}; } catch (e) { return {}; } },
    RL() { try { return typeof RATING_LABEL !== 'undefined' ? RATING_LABEL : {}; } catch (e) { return {}; } },
  };
  const h = s => { try { if (typeof esc === 'function') return esc(s); } catch (e) {} return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); };
  const st = {
    get(k) { try { if (typeof store !== 'undefined') return store.get(k); } catch (e) {} return null; },
    set(k, v) { try { if (typeof store !== 'undefined') store.set(k, v); } catch (e) {} },
  };
  const DASH = '<span class="muted">—</span>';
  const isNum = v => typeof v === 'number' && isFinite(v);

  // ---- fetching (cached; at most every 30 s unless forced)
  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
    return r.json();
  }
  function moversRefresh(force) {
    if (MV.inflight) return MV.inflight;
    if (!force && MV.fetchedAt && Date.now() - MV.fetchedAt < REFRESH_MS) return Promise.resolve(false);
    MV.fetchedAt = Date.now();
    MV.inflight = Promise.allSettled([getJSON('/api/history'), getJSON('/api/snapshots'), getJSON('/api/events?since=0')]).then(res => {
      if (res[0].status === 'fulfilled' && res[0].value) MV.history = res[0].value;
      if (res[1].status === 'fulfilled' && res[1].value) MV.snaps = res[1].value;
      if (res[2].status === 'fulfilled' && res[2].value) MV.events = res[2].value;
      for (const r of res) if (r.status === 'rejected') console.warn('movers:', r.reason && r.reason.message);
      computeCalls();
      return true;
    }).catch(e => { console.warn('movers:', e && e.message); return false; }).finally(() => { MV.inflight = null; });
    return MV.inflight;
  }

  // ---- series helpers. A race series is [[t, kD, pD], ...]; pick() maps a point to the chosen source.
  const avg2 = (a, b) => isNum(a) && isNum(b) ? (a + b) / 2 : isNum(a) ? a : isNum(b) ? b : null;
  const pick = (k, p, src) => src === 'k' ? (isNum(k) ? k : null) : src === 'p' ? (isNum(p) ? p : null) : avg2(k, p);
  function raceSeries(id) {
    const H = MV.history && MV.history.races; const raw = H && Array.isArray(H[id]) ? H[id] : [];
    const out = []; let lastT = null;
    for (const x of raw) { if (!Array.isArray(x) || !isNum(x[0])) continue; if (x[0] === lastT) { out[out.length - 1] = x; continue; } out.push(x); lastT = x[0]; }
    return out;
  }
  const intervalMs = () => (MV.history && isNum(MV.history.intervalMs) ? MV.history.intervalMs : 30e3);
  // value at time t: last non-null point at or before t; if the series starts just after t (within 2 intervals) use its first point
  function valueAt(pts, t, src) {
    let v = null, first = null;
    for (const x of pts) {
      const y = pick(x[1], x[2], src); if (y === null) continue;
      if (first === null) first = x;
      if (x[0] <= t) v = y; else break;
    }
    if (v === null && first && first[0] - t <= 2 * intervalMs()) v = pick(first[1], first[2], src);
    return v;
  }
  function lastValue(pts, src) { for (let i = pts.length - 1; i >= 0; i--) { const y = pick(pts[i][1], pts[i][2], src); if (y !== null) return y; } return null; }
  function histNow() {
    const H = MV.history; let t = 0;
    if (H && Array.isArray(H.control) && H.control.length) t = H.control[H.control.length - 1].t || 0;
    if (H && H.races) for (const k in H.races) { const a = H.races[k]; if (Array.isArray(a) && a.length && a[a.length - 1][0] > t) t = a[a.length - 1][0]; }
    return t || Date.now();
  }
  function histStart() {
    const H = MV.history; let t = Infinity;
    if (H && Array.isArray(H.control) && H.control.length) t = H.control[0].t;
    if (H && H.races) for (const k in H.races) { const a = H.races[k]; if (Array.isArray(a) && a.length && a[0][0] < t) t = a[0][0]; }
    return isFinite(t) ? t : null;
  }
  const logit = p => { const q = Math.min(99.5, Math.max(0.5, p)) / 100; return Math.log(q / (1 - q)); };

  // ---- race metadata
  function raceInfo(id) {
    const SE = G.SEATS(), s = G.S();
    let x = null;
    const m = /^([A-Z]{2})-(Sen|Gov|\d+)$/.exec(id || '');
    if (m && SE) {
      if (m[2] === 'Sen') x = (SE.senate || []).find(r => r.state === m[1]) || null;
      else if (m[2] === 'Gov') x = (SE.governor || []).find(r => r.state === m[1]) || null;
      else x = G.HOUSE()[id] || null;
    }
    if (!x && s && s.nyt && s.nyt.races) x = s.nyt.races[id] || null;
    return x;
  }
  function currentMarket(id) {
    const SE = G.SEATS(), s = G.S();
    const m = SE && SE.markets ? SE.markets[id] : null;
    const k = s && s.kalshi && s.kalshi.races ? s.kalshi.races[id] : null, p = s && s.polymarket && s.polymarket.races ? s.polymarket.races[id] : null;
    return {
      kD: m && isNum(m.kD) ? m.kD : k && isNum(k.pD) ? k.pD : null,
      pD: m && isNum(m.pD) ? m.pD : p && isNum(p.pD) ? p.pD : null,
      kVol: m && isNum(m.kVol) ? m.kVol : k && isNum(k.volume) ? k.volume : null,
      pVol: m && isNum(m.pVol) ? m.pVol : p && isNum(p.volume) ? p.volume : null,
    };
  }
  function snapshot(label) { const sn = MV.snaps && MV.snaps.snapshots; return sn && sn[label] ? sn[label] : null; }
  function snapValue(snap, id, src) {
    const a = (snap.markets && snap.markets[id]) || {}, b = (snap.bell && snap.bell[id]) || {};
    return pick(isNum(a.kD) ? a.kD : b.kD, isNum(a.pD) ? a.pD : b.pD, src);
  }
  function allIds() {
    const ids = new Set();
    if (MV.history && MV.history.races) for (const k in MV.history.races) ids.add(k);
    const SE = G.SEATS(); if (SE && SE.markets) for (const k in SE.markets) ids.add(k);
    const s = G.S(); if (s && s.config && Array.isArray(s.config.races)) for (const r of s.config.races) if (r && r.id) ids.add(r.id);
    return [...ids];
  }

  // ---- calls and "moved before the call"
  function computeCalls() {
    const evs = (MV.events && Array.isArray(MV.events.events)) ? MV.events.events : [];
    const calls = {}, precall = {};
    for (const e of evs) if (e && e.type === 'call' && e.id && isNum(e.t)) { if (!calls[e.id] || e.t < calls[e.id].t) calls[e.id] = { t: e.t, party: e.party || null }; }
    for (const id in calls) {
      const tc = calls[id].t, t0 = tc - PRE_CALL_MS;
      // 1) the server's own odds-move alerts in the 30 min before the call
      let hit = evs.some(e => e && e.type === 'odds' && e.id === id && isNum(e.t) && e.t >= t0 && e.t <= tc && e.meta && isNum(e.meta.from) && isNum(e.meta.to) && Math.abs(e.meta.to - e.meta.from) >= PRE_CALL_PTS);
      // 2) or the history itself shows a ≥5 pt excursion inside that window, on either source
      if (!hit) {
        const pts = raceSeries(id);
        for (const src of ['k', 'p']) {
          const base = valueAt(pts, t0, src); if (base === null) continue;
          for (const x of pts) { if (x[0] < t0) continue; if (x[0] > tc) break; const y = pick(x[1], x[2], src); if (y !== null && Math.abs(y - base) >= PRE_CALL_PTS) { hit = true; break; } }
          if (hit) break;
        }
      }
      if (hit) precall[id] = true;
    }
    MV.calls = calls; MV.precall = precall;
  }

  // ---- formatting
  const probCell = v => !isNum(v) ? DASH : v >= 50 ? `<span class="d num">D ${v.toFixed(1)}</span>` : `<span class="r num">R ${(100 - v).toFixed(1)}</span>`;
  const signed = (v, dp = 1) => !isNum(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(dp);
  const partyCls = v => !isNum(v) || v === 0 ? 'dim' : v > 0 ? 'd' : 'r';
  const fmtVol = v => !isNum(v) || v <= 0 ? '—' : v >= 5e4 ? '$' + (v / 1e6).toFixed(1) + 'M' : '$' + Math.max(1, Math.round(v / 1e3)) + 'K';
  const fmtSpan = ms => { const m = Math.round(ms / 60e3); return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}` : `${m}m`; };
  const etTime = t => { try { return new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET'; } catch (e) { return ''; } };

  function spark(pts, tStart, w = 120, hgt = 24) {
    const k = pts.filter(x => isNum(x[1])), p = pts.filter(x => isNum(x[2]));
    if (k.length + p.length < 2) return `<svg width="${w}" height="${hgt}"></svg>`;
    const vals = k.map(x => x[1]).concat(p.map(x => x[2]));
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi - lo < 4) { const m = (hi + lo) / 2; lo = m - 2; hi = m + 2; }
    const t0 = pts[0][0], t1 = Math.max(pts[pts.length - 1][0], t0 + 1);
    const X = t => 1 + (t - t0) / (t1 - t0) * (w - 2), Y = v => hgt - 2 - (v - lo) / (hi - lo) * (hgt - 4);
    const line = (a, i) => a.map((x, j) => `${j ? 'L' : 'M'}${X(x[0]).toFixed(1)},${Y(x[i]).toFixed(1)}`).join('');
    const mid = lo < 50 && hi > 50 ? `<line x1="0" x2="${w}" y1="${Y(50).toFixed(1)}" y2="${Y(50).toFixed(1)}" stroke="var(--line2)" stroke-width="1"/>` : '';
    const mark = isNum(tStart) && tStart > t0 && tStart < t1 ? `<line x1="${X(tStart).toFixed(1)}" x2="${X(tStart).toFixed(1)}" y1="0" y2="${hgt}" stroke="var(--ink3)" stroke-width="1" stroke-dasharray="1 2"/>` : '';
    return `<svg width="${w}" height="${hgt}" role="img" aria-label="2 hour odds history, ${lo.toFixed(0)} to ${hi.toFixed(0)} percent D">${mid}${mark}`
      + (p.length > 1 ? `<path d="${line(p, 2)}" fill="none" stroke="var(--ink3)" stroke-width="1.3" stroke-dasharray="3 2"/>` : '')
      + (k.length > 1 ? `<path d="${line(k, 1)}" fill="none" stroke="var(--ink)" stroke-width="1.3"/>` : '')
      + `<title>${lo.toFixed(0)}–${hi.toFixed(0)}% D · — Kalshi ┄ Poly</title></svg>`;
  }

  // ---- computing the movers table
  function windowSpec(win) {
    const tNow = histNow();
    if (win === '6pm' || win === 'midnight') { const sn = snapshot(win); return sn ? { snap: sn, tStart: sn.t, tNow, label: `vs ${win} (${etTime(sn.t)})` } : null; }
    const mins = parseInt(win, 10) || 60;
    return { snap: null, tStart: tNow - mins * 60e3, tNow, label: `last ${fmtSpan(mins * 60e3)}` };
  }
  function computeMovers(spec, src) {
    const rows = [];
    for (const id of allIds()) {
      const pts = raceSeries(id);
      const cur = currentMarket(id);
      let now = lastValue(pts, src);
      if (now === null) now = pick(cur.kD, cur.pD, src);
      const then = spec.snap ? snapValue(spec.snap, id, src) : valueAt(pts, spec.tStart, src);
      if (!isNum(now) || !isNum(then)) continue;
      const d = now - then;
      if (Math.abs(d) < 1) continue;
      const info = raceInfo(id);
      const call = MV.calls[id];
      const winner = (info && info.winnerParty) || (call && call.party) || null;
      const vol = src === 'k' ? cur.kVol : src === 'p' ? cur.pVol : (isNum(cur.kVol) || isNum(cur.pVol) ? (cur.kVol || 0) + (cur.pVol || 0) : null);
      rows.push({ id, now, then, d, lo: logit(now) - logit(then), pts, info, winner, precall: !!MV.precall[id] && !!(call || winner), vol });
    }
    rows.sort((a, b) => Math.abs(b.d) - Math.abs(a.d) || Math.abs(b.lo) - Math.abs(a.lo));   // rank by points moved; log-odds breaks ties
    return rows;
  }
  function consensus(src) {
    const tNow = histNow(), tStart = tNow - 60 * 60e3; let nD = 0, nR = 0;
    for (const id of allIds()) {
      const pts = raceSeries(id); if (pts.length < 2) continue;
      const a = valueAt(pts, tStart, src), b = lastValue(pts, src);
      if (!isNum(a) || !isNum(b)) continue;
      if (b - a >= 5) nD++; else if (a - b >= 5) nR++;
    }
    return { nD, nR };
  }
  function controlMoves(src) {
    const C = MV.history && Array.isArray(MV.history.control) ? MV.history.control.filter(x => x && isNum(x.t)) : [];
    if (C.length < 2) return null;
    const tNow = C[C.length - 1].t, tStart = tNow - 60 * 60e3;
    const val = (x, ch) => pick(x['k' + ch], x['p' + ch], src);
    const at = (ch, t) => { let v = null, first = null; for (const x of C) { const y = val(x, ch); if (y === null) continue; if (first === null) first = y; if (x.t <= t) v = y; else break; } return v === null && C[0].t - t <= 2 * intervalMs() ? first : v; };
    const last = ch => { for (let i = C.length - 1; i >= 0; i--) { const y = val(C[i], ch); if (y !== null) return y; } return null; };
    return ['H', 'S'].map(ch => ({ ch, then: at(ch, tStart), now: last(ch) }));
  }

  // ---- render
  function renderMovers(container) {
    try {
      container = container || MV.container || document.getElementById('movers');
      if (!container) return;
      MV.container = container;
      bind(container);
      draw(container);
      moversRefresh().then(changed => { if (changed && MV.container && MV.container.isConnected) draw(MV.container); });
    } catch (e) { console.warn('movers render:', e); }
  }

  function draw(c) {
    let win = String(st.get('mv:win') || '60'), src = String(st.get('mv:src') || 'avg');
    if (!WINDOWS.some(w => w[0] === win)) win = '60';
    if (!SOURCES.some(s => s[0] === src)) src = 'avg';
    if ((win === '6pm' || win === 'midnight') && !snapshot(win)) win = '60';

    const loaded = !!MV.history;
    const tabs = `<span class="tabs" data-label="window" data-mv="win">${WINDOWS.map(([k, l]) => {
      const isSnap = k === '6pm' || k === 'midnight', has = !isSnap || !!snapshot(k);
      return `<button data-v="${k}" class="${k === win ? 'on' : ''}"${has ? '' : ' disabled title="No ' + k + ' snapshot yet"'}${isSnap && has ? ` title="Snapshot taken ${h(etTime(snapshot(k).t))}"` : ''}>${l}</button>`;
    }).join('')}</span><span class="tabs" data-label="source" data-mv="src">${SOURCES.map(([k, l]) => `<button data-v="${k}" class="${k === src ? 'on' : ''}">${l}</button>`).join('')}</span>`;

    const t0 = histStart(), tNow = histNow();
    const span = t0 !== null ? tNow - t0 : 0;
    const meta = !loaded ? 'loading history…' : t0 === null ? 'no history yet' : `history ${fmtSpan(span)} · ${Object.keys(MV.history.races || {}).length} markets · updated ${new Date(tNow).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false })} ET`;
    let html = `<div class="mv-ctl">${tabs}<span class="spacer"></span><span class="mv-meta">${h(meta)}</span></div>`;

    // summaries (fixed 60 min)
    const short = span < 60 * 60e3 - 2 * intervalMs() ? ` <span class="muted">(only ${fmtSpan(span)} of history)</span>` : '';
    const srcName = (SOURCES.find(s => s[0] === src) || [0, 'Avg'])[1];
    if (loaded) {
      const cs = consensus(src);
      html += `<div class="mv-sum"><span class="lbl">MARKET CONSENSUS</span><b class="d num">${cs.nD}</b> races moved ≥5 pts toward D, <b class="r num">${cs.nR}</b> toward R in the last 60 min · ${h(srcName)}${short}</div>`;
      const cm = controlMoves(src);
      const chName = { H: 'House', S: 'Senate' };
      const ctl = cm ? cm.map(x => {
        if (!isNum(x.now)) return `${chName[x.ch]} —`;
        const fav = x.now >= 50, show = v => (fav ? v : 100 - v).toFixed(1);
        const d = isNum(x.then) ? x.now - x.then : null;
        return `${chName[x.ch]} <span class="${fav ? 'd' : 'r'} num">${fav ? 'D' : 'R'} ${show(x.now)}%</span> <span class="muted">from ${isNum(x.then) ? show(x.then) : '—'}</span> ${isNum(d) ? `<b class="num ${partyCls(d)}">${signed(d)}</b> pts D` : ''}`;
      }).join(' &nbsp;·&nbsp; ') : '<span class="muted">—</span>';
      html += `<div class="mv-sum"><span class="lbl">CONTROL, 60 MIN</span>${ctl}</div>`;
    }

    // table
    const spec = loaded ? windowSpec(win) : null;
    const rows = spec ? computeMovers(spec, src) : [];
    const shown = MV.showAll ? rows : rows.slice(0, 25);
    const RL = G.RL();
    const thenLbl = spec && spec.snap ? h(win) : 'then';
    html += `<table class="mv-tbl"><thead><tr><th class="l"></th><th class="l">Race</th><th class="l">Rating</th><th>Now</th><th>${thenLbl}</th><th title="Change in Democratic win probability, percentage points">Δ pts</th><th title="logit(now) − logit(then); positive = toward D">Δ log-odds</th><th class="l" title="2-hour history · solid Kalshi, dashed Polymarket · dotted line = window start">2h · K ┄P</th><th title="Traded volume (${h(srcName === 'Avg' ? 'Kalshi + Polymarket' : srcName)})">Volume</th><th class="l">Tags</th></tr></thead><tbody>`;
    if (!shown.length) {
      const why = !loaded ? 'Loading…' : !spec ? 'No snapshot for this window.' : t0 === null || span < 60e3 ? 'Not enough history yet (needs at least two points).' : `No race moved ≥1 pt over the ${h(spec.label)}${span + 2 * intervalMs() < tNow - spec.tStart ? ` — history only covers ${fmtSpan(span)}` : ''}.`;
      html += `<tr><td colspan="10" class="mv-empty">${why}</td></tr>`;
    }
    shown.forEach((r, i) => {
      const rating = r.info && r.info.rating ? (RL[r.info.rating] || r.info.rating) : '';
      const tags = (r.precall ? `<span class="tag pre" title="Odds moved ≥${PRE_CALL_PTS} pts in the 30 min before the AP call">pre-call</span>` : '')
        + (r.winner === 'D' || r.winner === 'R' ? `<span class="tag c${r.winner}">called ${r.winner}</span>` : r.winner ? `<span class="tag">called ${h(r.winner)}</span>` : '');
      html += `<tr><td class="rank num">${i + 1}</td><td class="l race"><a class="rid" href="#" data-id="${h(r.id)}">${h(r.id)}</a></td><td class="l dim">${rating ? h(rating) : DASH}</td>`
        + `<td class="big">${probCell(r.now)}</td><td>${probCell(r.then)}</td>`
        + `<td class="num big ${partyCls(r.d)}">${signed(r.d)}</td><td class="num ${partyCls(r.lo)}">${signed(r.lo, 2)}</td>`
        + `<td class="l spk">${spark(r.pts, spec.snap ? spec.snap.t : spec.tStart)}</td><td class="num dim">${fmtVol(r.vol)}</td><td class="l">${tags}</td></tr>`;
    });
    html += '</tbody></table>';
    if (rows.length) html += `<div class="mv-foot"><span>${shown.length} of ${rows.length} races moved ≥1 pt · ${h(spec.label)} · ${h(srcName)} · ranked by |Δ log-odds|</span>${rows.length > 25 ? `<button data-mv="all">${MV.showAll ? 'Top 25' : 'Show all'}</button>` : ''}</div>`;

    // keep scroll position across the 30 s re-render
    const sc = c.closest('#viewbody'), top = sc ? sc.scrollTop : 0;
    if (!c.classList.contains('mv')) c.classList.add('mv');
    c.innerHTML = html;
    if (sc) sc.scrollTop = top;
  }

  function bind(c) {
    if (c._mvBound) return; c._mvBound = true;
    c.addEventListener('click', e => {
      const t = e.target; if (!t || !t.closest) return;
      const a = t.closest('a.rid');
      if (a) { e.preventDefault(); if (typeof window.openRaceModal === 'function') window.openRaceModal(a.dataset.id); return; }
      const b = t.closest('button'); if (!b || b.disabled) return;
      if (b.dataset.mv === 'all') { MV.showAll = !MV.showAll; draw(c); return; }
      const grp = b.parentElement && b.parentElement.dataset.mv;
      if (grp === 'win') { st.set('mv:win', b.dataset.v); draw(c); }
      else if (grp === 'src') { st.set('mv:src', b.dataset.v); draw(c); }
    });
  }

  window.renderMovers = renderMovers;
  window.moversRefresh = moversRefresh;
})();
