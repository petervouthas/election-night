// "What to watch next": poll-closing timeline. Exposes window.renderWatch(container).
// Reads page globals (S, SEATS, HOUSE_BY_ID, helpers) defensively; renders "waiting for data" when absent.
(function () {
  'use strict';
  const TZ = 'America/New_York';
  const VISIBLE = 6;                       // race lines shown per block before "+N more"
  const RANK = { 'tossup': 0, 'lean-dem': 1, 'lean-rep': 1, 'likely-dem': 2, 'likely-rep': 2 };
  const OFFICE_RANK = { S: 0, G: 1, H: 2 };
  const LABEL = { 'tossup': 'Toss-up', 'lean-dem': 'Lean D', 'lean-rep': 'Lean R', 'likely-dem': 'Likely D', 'likely-rep': 'Likely R', 'solid-dem': 'Solid D', 'solid-rep': 'Solid R' };
  const expanded = new Set();              // block keys the user expanded (survives re-renders)

  const get = f => { try { return f(); } catch (e) { return null; } };
  const gS = () => get(() => typeof S !== 'undefined' ? S : null);
  const gSEATS = () => get(() => typeof SEATS !== 'undefined' ? SEATS : null);
  const gHBI = () => get(() => typeof HOUSE_BY_ID !== 'undefined' ? HOUSE_BY_ID : null);
  const E = s => { const f = get(() => typeof esc === 'function' ? esc : null); return f ? f(s) : String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); };
  const ratingLabel = r => (get(() => typeof RATING_LABEL !== 'undefined' ? RATING_LABEL : null) || LABEL)[r] || r || '—';
  const has = v => v !== null && v !== undefined && !(typeof v === 'number' && isNaN(v));
  const fmtMargin = v => { const f = get(() => typeof fmtM === 'function' ? fmtM : null); if (f) return f(v); if (!has(v)) return '—'; return Math.abs(v) < .05 ? 'EVEN' : v > 0 ? `D+${v.toFixed(1)}` : `R+${(-v).toFixed(1)}`; };
  const prob = id => get(() => typeof marketProb === 'function' ? marketProb(id).v : null);
  const DASH = '<span class="muted">—</span>';

  const raceId = r => r.office === 'S' ? `${r.state}-Sen` : r.office === 'G' ? `${r.state}-Gov` : `${r.state}-${parseInt(r.seat, 10) || r.seat}`;
  const fmtTime = t => new Date(t).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  function fmtDur(ms) {
    const m = Math.round(Math.abs(ms) / 60000), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), mm = m % 60;
    return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
  }

  // ---- competitive races indexed by state, rebuilt only when the SEATS object changes
  let idxFor = null, idx = {};
  function competitiveByState(seats) {
    if (idxFor === seats) return idx;
    idx = {}; idxFor = seats;
    if (!seats) return idx;
    const seen = new Set();
    for (const key of ['senate', 'governor', 'house']) for (const r of seats[key] || []) {
      if (!r || !r.state || !(r.rating in RANK) || r.uncontested) continue;
      const id = raceId(r); if (seen.has(id)) continue; seen.add(id);
      (idx[r.state] = idx[r.state] || []).push({ id, race: r, rating: r.rating, office: r.office });
    }
    for (const st in idx) idx[st].sort((a, b) => RANK[a.rating] - RANK[b.rating] || OFFICE_RANK[a.office] - OFFICE_RANK[b.office] || a.id.localeCompare(b.id, 'en', { numeric: true }));
    return idx;
  }
  function seatsRace(id, seats) {
    const hbi = gHBI(); if (hbi && hbi[id]) return hbi[id];
    if (!seats) return null;
    const m = /^([A-Z]{2})-(Sen|Gov)$/.exec(id); if (!m) return null;
    return (seats[m[2] === 'Sen' ? 'senate' : 'governor'] || []).find(r => r.state === m[1]) || null;
  }

  // ---- one race line
  function probCell(id, office) {
    if (office === 'G') return DASH;
    const v = prob(id);
    if (!has(v)) return DASH;
    return v >= 50 ? `<span class="d num">D ${v.toFixed(0)}</span>` : `<span class="r num">R ${(100 - v).toFixed(0)}</span>`;
  }
  function liveCell(r) {
    if (!r) return '';
    if (r.winnerParty) return `<span class="wt-called ${r.winnerParty === 'D' ? 'd' : r.winnerParty === 'R' ? 'r' : 'o'}">CALLED ${E(r.winnerParty)}</span>`;
    if (!r.totalVotes && !r.eevp) return '';
    const m = r.liveMargin, cls = !has(m) ? '' : m > 0 ? 'd' : m < 0 ? 'r' : '';
    return `<span class="num">${has(r.eevp) ? r.eevp : 0}% in</span> · <span class="num ${cls}">${fmtMargin(m)}</span>`;
  }
  function line(it) {
    const r = it.race, rating = it.rating || (r && r.rating);
    return `<div class="wt-race${it.bell ? ' bell' : ''}">
      <a href="#" class="wt-id" data-id="${E(it.id)}">${E(it.id)}</a>
      <span class="wt-rating rt-${E(rating || 'none')}">${E(ratingLabel(rating))}</span>
      <span class="wt-prob">${probCell(it.id, it.office)}</span>
      <span class="wt-live">${liveCell(r)}</span>
      ${it.bell ? `<span class="wt-sig"><span class="wt-tag">bellwether</span>${E(it.signal || '')}</span>` : ''}
    </div>`;
  }

  // ---- data model: blocks by closing time
  function buildBlocks(s, seats) {
    const byT = new Map();
    for (const p of (s.nyt && s.nyt.pollClosing) || []) {
      const t = Date.parse(p && p.t); if (!p || !p.state || isNaN(t)) continue;
      if (!byT.has(t)) byT.set(t, []);
      byT.get(t).push(p.state);
    }
    const comp = competitiveByState(seats);
    const cfg = (s.config && s.config.races) || [];
    const nytR = (s.nyt && s.nyt.races) || {};
    return [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, states]) => {
      states.sort();
      const set = new Set(states), ids = new Set();
      const bells = cfg.filter(c => set.has(c.state)).map(c => {
        ids.add(c.id);
        const office = c.office === 'senate' ? 'S' : c.office === 'governor' ? 'G' : /-Gov$/.test(c.id) ? 'G' : /-Sen$/.test(c.id) ? 'S' : 'H';
        const race = nytR[c.id] || seatsRace(c.id, seats);
        return { id: c.id, bell: true, signal: c.signal, office, race, rating: race && race.rating };
      });
      const others = [];
      for (const st of states) for (const x of comp[st] || []) if (!ids.has(x.id)) others.push(x);
      others.sort((a, b) => RANK[a.rating] - RANK[b.rating] || OFFICE_RANK[a.office] - OFFICE_RANK[b.office] || a.id.localeCompare(b.id, 'en', { numeric: true }));
      return { t, key: String(t), states, bells, others };
    });
  }

  function onClick(e) {
    const a = e.target.closest && e.target.closest('a.wt-id');
    if (a) { e.preventDefault(); if (typeof window.openRaceModal === 'function') window.openRaceModal(a.dataset.id); return; }
    const b = e.target.closest && e.target.closest('button.wt-more');
    if (b) {
      const k = b.dataset.key, blk = b.closest('.wt-block');
      if (expanded.has(k)) expanded.delete(k); else expanded.add(k);
      if (blk) { blk.classList.toggle('open', expanded.has(k)); b.textContent = expanded.has(k) ? 'show fewer' : b.dataset.label; }
    }
  }

  window.renderWatch = function (container) {
    if (!container) return;
    if (!container.__wtBound) { container.addEventListener('click', onClick); container.__wtBound = true; }
    container.classList.add('wt');
    const s = gS(), seats = gSEATS();
    if (!s || !s.nyt || !(s.nyt.pollClosing || []).length) {
      container.innerHTML = '<div class="wt-summary"><span class="muted">waiting for data…</span></div>';
      return;
    }
    let blocks;
    try { blocks = buildBlocks(s, seats); } catch (e) { container.innerHTML = `<div class="wt-summary"><span class="muted">waiting for data… (${E(e.message)})</span></div>`; return; }
    const now = Date.now();
    const nextI = blocks.findIndex(b => b.t > now);

    // summary
    let called = { D: 0, R: 0, O: 0 }, anyClosed = false;
    for (const b of blocks) {
      if (b.t <= now) anyClosed = true;
      for (const it of b.bells.concat(b.others)) { const w = it.race && it.race.winnerParty; if (w) called[w in called ? w : 'O']++; }
    }
    let summary;
    if (nextI >= 0) {
      const nb = blocks[nextI], n = nb.bells.length + nb.others.length;
      summary = `<b>Next: ${fmtTime(nb.t)}</b> <span class="muted">(in ${fmtDur(nb.t - now)})</span> · <span class="wt-sts">${nb.states.map(E).join(' ')}</span> · <b class="num">${n}</b> key race${n === 1 ? '' : 's'}`
        + (nb.bells.length ? ` · bellwethers ${nb.bells.map(x => E(x.id)).join(', ')}` : '');
    } else summary = '<b>All polls closed</b>';
    if (anyClosed) summary += ` <span class="wt-callsum">· Called so far: <span class="d num">D ${called.D}</span> · <span class="r num">R ${called.R}</span>${called.O ? ` · <span class="o num">O ${called.O}</span>` : ''}</span>`;
    if (!seats) summary += ' <span class="muted">· waiting for results feed…</span>';

    // timeline
    const nowLabel = new Date(now).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
    const nowMarker = `<div class="wt-now"><span>now · ${nowLabel} ET</span></div>`;
    let html = `<div class="wt-summary">${summary}</div><div class="wt-line">`;
    blocks.forEach((b, i) => {
      if (i === nextI) html += nowMarker;
      const past = b.t <= now, next = i === nextI;
      const items = b.bells.concat(b.others);
      const nVis = Math.max(VISIBLE, b.bells.length);
      const hidden = items.length - nVis;
      const open = expanded.has(b.key);
      const cnt = { D: 0, R: 0 }; for (const it of items) { const w = it.race && it.race.winnerParty; if (w === 'D' || w === 'R') cnt[w]++; }
      html += `<section class="wt-block${past ? ' past' : ''}${next ? ' next' : ''}${open ? ' open' : ''}">
        <div class="wt-dot"></div>
        <header>
          <span class="wt-time num">${fmtTime(b.t)}</span>
          <span class="wt-cd num">${past ? `closed ${fmtDur(now - b.t)} ago` : `closes in ${fmtDur(b.t - now)}`}</span>
          <span class="wt-sts">${b.states.map(E).join(' ')}</span>
          <span class="wt-n muted">${items.length ? `${items.length} key race${items.length === 1 ? '' : 's'}` : ''}${past && (cnt.D || cnt.R) ? ` · called <span class="d">D ${cnt.D}</span> <span class="r">R ${cnt.R}</span>` : ''}</span>
        </header>
        <div class="wt-races">${items.length ? items.map((it, j) => j < nVis ? line(it) : line(it).replace('class="wt-race', 'class="wt-race wt-extra')).join('') : '<div class="muted wt-none">no competitive races</div>'}</div>
        ${hidden > 0 ? `<button class="wt-more" data-key="${b.key}" data-label="+${hidden} more key race${hidden === 1 ? '' : 's'}">${open ? 'show fewer' : `+${hidden} more key race${hidden === 1 ? '' : 's'}`}</button>` : ''}
      </section>`;
    });
    if (nextI < 0) html += nowMarker;
    html += '</div>';
    container.innerHTML = html;
  };
})();
