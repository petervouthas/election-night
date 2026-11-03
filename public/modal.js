// Race-detail modal. Exposes window.openRaceModal(id) / window.closeRaceModal().
// Reads the page's globals (S, SEATS, SPEND, HOUSE_BY_ID, DIST, geoFeatures, helpers) defensively: anything missing renders "—".
(function () {
  'use strict';
  const STATE_NAME = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming' };
  const DASH = '<span class="muted">—</span>';
  const REFRESH_MS = 5000;

  // page helper functions, looked up lazily (typeof guards: any may be absent)
  const FN = f => typeof f === 'function' ? f : null;
  const FNS = {
    esc: () => FN(typeof esc !== 'undefined' && esc), fmtMargin: () => FN(typeof fmtMargin !== 'undefined' && fmtMargin),
    fmtOver: () => FN(typeof fmtOver !== 'undefined' && fmtOver), fmtUSD: () => FN(typeof fmtUSD !== 'undefined' && fmtUSD),
    ago: () => FN(typeof ago !== 'undefined' && ago), classify: () => FN(typeof classify !== 'undefined' && classify),
    seatColor: () => FN(typeof seatColor !== 'undefined' && seatColor), liveMarginFor: () => FN(typeof liveMarginFor !== 'undefined' && liveMarginFor),
    margin2024For: () => FN(typeof margin2024For !== 'undefined' && margin2024For), pollFor: () => FN(typeof pollFor !== 'undefined' && pollFor),
    spendFor: () => FN(typeof spendFor !== 'undefined' && spendFor), loadTopo: () => FN(typeof loadTopo !== 'undefined' && loadTopo),
    loadDistricts: () => FN(typeof loadDistricts !== 'undefined' && loadDistricts),
  };
  // ---- safe access to page globals (top-level let/const of index.html are visible by name, not on window)
  const G = {
    S: () => { try { return typeof S !== 'undefined' ? S : null; } catch (e) { return null; } },
    SEATS: () => { try { return typeof SEATS !== 'undefined' ? SEATS : null; } catch (e) { return null; } },
    SPEND: () => { try { return typeof SPEND !== 'undefined' ? SPEND : null; } catch (e) { return null; } },
    HBI: () => { try { return typeof HOUSE_BY_ID !== 'undefined' ? HOUSE_BY_ID : null; } catch (e) { return null; } },
    DIST: () => { try { return typeof DIST !== 'undefined' ? DIST : null; } catch (e) { return null; } },
    GEO: () => { try { return typeof geoFeatures !== 'undefined' ? geoFeatures : null; } catch (e) { return null; } },
    fn: name => { try { return FNS[name] ? FNS[name]() : null; } catch (e) { return null; } },
  };
  const has = v => v !== null && v !== undefined && !(typeof v === 'number' && isNaN(v));
  const e_ = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const esc_ = s => { const f = G.fn('esc'); return f ? f(s) : e_(s); };
  const margin = v => { if (!has(v)) return DASH; const f = G.fn('fmtMargin'); if (f) return f(v); return Math.abs(v) < .05 ? 'EVEN' : v > 0 ? `<span class="d">D+${v.toFixed(1)}</span>` : `<span class="r">R+${(-v).toFixed(1)}</span>`; };
  const over = v => { if (!has(v)) return DASH; const f = G.fn('fmtOver'); return f ? f(v) : (v > 0 ? '+' : '') + v.toFixed(1); };
  const usd = v => { if (!has(v)) return DASH; const f = G.fn('fmtUSD'); return f ? f(v) : '$' + Math.round(v).toLocaleString(); };
  const int = v => has(v) ? Math.round(v).toLocaleString('en-US') : DASH;
  const pct = (v, d = 1) => has(v) ? (+v).toFixed(d) + '%' : DASH;
  const cents = v => has(v) ? (v * 100).toFixed(1) + '¢' : DASH;
  const party = p => p === 'D' ? '<span class="d">D</span>' : p === 'R' ? '<span class="r">R</span>' : p ? `<span class="o">${e_(p)}</span>` : DASH;
  const ordinal = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  const fmtET = iso => { const t = Date.parse(iso); if (!t) return null; return new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET'; };
  const agoTxt = iso => { const t = Date.parse(iso); if (!t) return '—'; const f = G.fn('ago'); return f ? f(t) + ' ago' : new Date(t).toLocaleString(); };

  // ---- race id parsing + data lookup
  function parseId(id) {
    id = String(id || '').trim();
    let m = /^([A-Z]{2})-Sen$/i.exec(id);
    if (m) return { id: `${m[1].toUpperCase()}-Sen`, state: m[1].toUpperCase(), office: 'senate', seat: null };
    m = /^([A-Z]{2})-Gov$/i.exec(id);
    if (m) return { id: `${m[1].toUpperCase()}-Gov`, state: m[1].toUpperCase(), office: 'governor', seat: null };
    m = /^([A-Z]{2})-(\d+)$/i.exec(id);
    if (m) { const st = m[1].toUpperCase(), n = parseInt(m[2], 10); return { id: `${st}-${n}`, state: st, office: 'house', seat: n }; }
    return { id, state: id.slice(0, 2).toUpperCase(), office: 'house', seat: null };
  }
  function lookup(P) {
    const s = G.S(), seats = G.SEATS();
    const cfg = s && s.config && Array.isArray(s.config.races) ? s.config.races.find(r => r.id === P.id) || null : null;
    const nytB = s && s.nyt && s.nyt.races ? s.nyt.races[P.id] || null : null;
    let race = null;
    if (P.office === 'house') {
      const hbi = G.HBI(); race = (hbi && hbi[P.id]) || null;
      if (!race && seats && seats.house) race = seats.house.find(x => x.state === P.state && parseInt(x.seat, 10) === P.seat) || null;
    } else if (P.office === 'governor') {
      race = seats && seats.governor ? seats.governor.find(x => x.state === P.state) || null : null;
    } else if (seats && seats.senate) {
      const list = seats.senate.filter(x => x.state === P.state);
      race = list.find(x => !x.uncontested) || list[0] || null;
    }
    race = race || nytB;
    const row = Object.assign({}, cfg || {}, { id: P.id, office: P.office, state: P.state, nytRace: race || undefined });
    return { cfg, nytB, race, row };
  }
  const tryFn = (name, ...a) => { try { const f = G.fn(name); return f ? f(...a) : null; } catch (e) { return null; } };
  const houseCount = st => { const seats = G.SEATS(); return seats && seats.house ? seats.house.filter(x => x.state === st && x.seat).length : 0; };
  const isAtLarge = P => P.office === 'house' && (houseCount(P.state) === 1 || ['AK', 'DE', 'ND', 'SD', 'VT', 'WY'].includes(P.state));

  function statusOf(race) {
    if (!race) return { cls: 'U', label: 'NO DATA', fill: 'var(--none)' };
    let cls = tryFn('classify', race);
    if (!cls) cls = race.winnerParty ? race.winnerParty : (race.totalVotes && race.leaderParty ? 'l' + race.leaderParty : 'U');
    const fill = tryFn('seatColor', cls) || ({ D: 'var(--dem)', R: 'var(--rep)', O: 'var(--oth)', lD: 'var(--dem-lead)', lR: 'var(--rep-lead)' }[cls] || 'var(--none)');
    const label = cls === 'D' || cls === 'R' || cls === 'O' ? `CALLED ${cls}` : cls === 'lD' ? 'D LEADING' : cls === 'lR' ? 'R LEADING' : race.totalVotes ? 'COUNTING' : 'NO VOTES';
    return { cls: cls.length === 1 ? 'c' + cls : cls, label, fill };
  }

  // ---- Wikipedia
  // Drop Wikipedia's definitional opening ("X's 14th congressional district is an electoral district
  // for the U.S. Congress…", "The 2026 United States Senate election in Georgia will be held…") and
  // keep the sentences that actually describe the place or the race.
  function trimBoilerplate(text) {
    if (!text) return text;
    let t = text.replace(/\s+/g, ' ').trim();
    // "Florida's 14th congressional district is an electoral district for the U.S. Congress and includes…" → "The district includes…"
    t = t.replace(/^[^.]*?congressional district (?:is|was) (?:an? )?(?:electoral |congressional )?district (?:for|of|in) the (?:U\.S\.|United States) (?:Congress|House of Representatives),?\s*/i, 'The district ');
    t = t.replace(/^[^.]*?congressional district (?:is|was) (?:an? )?(?:U\.S\. |United States )?congressional district in the (?:Commonwealth|State|state) of [A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?\.\s*/, '');
    t = t.replace(/^[^.]*?congressional district (?:is|was) (?:an? )?(?:electoral |congressional )?district\s+/i, 'The district ');
    t = t.replace(/^The district (?:and|that|which) /i, 'The district ').replace(/^The district located/i, 'The district is located');
    if (/^The district [A-Z]/.test(t) || /^The district \./.test(t)) t = t.replace(/^The district \.?\s*/, '');   // prefix sentence had nothing else useful
    // "The 2026 United States Senate election in Georgia will be held on November 3, 2026, to elect…" → drop that sentence
    t = t.replace(/^The \d{4} United States (?:Senate|House)[^.]*? held [^.]*\.\s*/i, '');
    return t.trim() || text;
  }
  const wikiCache = new Map();   // title -> Promise<{title, extract, url} | null>
  function wikiTitles(P) {
    const name = STATE_NAME[P.state]; if (!name) return [];
    const u = s => s.replace(/ /g, '_');
    if (P.office === 'senate') return [u(`2026 United States Senate election in ${name}`), u(`2026 United States Senate special election in ${name}`)];
    if (P.office === 'governor') return [u(`2026 ${name} gubernatorial election`)];
    if (isAtLarge(P)) return [u(`${name}'s at-large congressional district`)];
    return P.seat ? [u(`${name}'s ${ordinal(P.seat)} congressional district`)] : [];
  }
  function fetchWiki(title) {
    if (!wikiCache.has(title)) {
      wikiCache.set(title, fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title), { headers: { accept: 'application/json' } })
        .then(r => r.ok ? r.json() : null)
        .then(j => j && j.extract && j.type !== 'disambiguation' ? { title, extract: j.extract, url: (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) || 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title) } : null)
        .catch(() => null));
    }
    return wikiCache.get(title);
  }
  async function wikiFor(P) { for (const t of wikiTitles(P)) { const w = await fetchWiki(t); if (w) return w; } return null; }

  // ---- DOM
  let root = null, curId = null, curP = null, timer = null, lastFocus = null, mapToken = 0;
  function ensureRoot() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'rmodal';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'rm-title');
    root.innerHTML = `<div class="rm-box" tabindex="-1">
      <div class="rm-hdr"></div>
      <div class="rm-body">
        <div class="rm-left"><div class="rm-map"></div><div class="rm-wiki muted">loading description…</div><div class="rm-links"></div></div>
        <div class="rm-right"></div>
      </div></div>`;
    root.addEventListener('mousedown', e => { if (e.target === root) closeRaceModal(); });
    root.addEventListener('click', e => { if (e.target.closest('.rm-x')) closeRaceModal(); });
    document.body.appendChild(root);
    return root;
  }
  window.addEventListener('keydown', e => {
    if (!root || !root.classList.contains('open')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeRaceModal(); return; }
    // keep the page's single-key shortcuts (t = theater, f = full screen) from firing under the modal
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) e.stopImmediatePropagation();
  }, true);

  // ---- header
  function renderHeader(P, L) {
    const s = G.S(), race = L.race, st = statusOf(race);
    let close = null;
    if (s && s.nyt && Array.isArray(s.nyt.pollClosing)) { const pc = s.nyt.pollClosing.find(p => p.state === P.state); if (pc) close = fmtET(pc.t); }
    if (!close && L.cfg && L.cfg.pollCloseET) close = L.cfg.pollCloseET + ' ET';
    const RL = (() => { try { return typeof RATING_LABEL !== 'undefined' ? RATING_LABEL : {}; } catch (e) { return {}; } })();
    const rating = race && race.rating ? (RL[race.rating] || race.rating) : null;
    const ratingCls = race && race.rating ? (/dem/.test(race.rating) ? 'd' : /rep/.test(race.rating) ? 'r' : 'dim') : 'muted';
    const name = STATE_NAME[P.state] || P.state;
    const sub = P.office === 'senate' ? `${name} · U.S. Senate${race && race.seatLabel ? ' · ' + e_(race.seatLabel) : ''}` : P.office === 'governor' ? `${name} · Governor` : `${name} · ${isAtLarge(P) ? 'At-large district' : P.seat ? ordinal(P.seat) + ' district' : 'House'}`;
    return `<span class="rm-id" id="rm-title">${e_(P.id)}</span>
      <span class="rm-sub">${sub}</span>
      <span class="rm-meta"><span>rating <b class="${ratingCls}">${rating ? e_(rating) : '—'}</b></span><span>polls close <b>${close ? e_(close) : '—'}</b></span>${L.cfg && L.cfg.signal ? `<span>bellwether <b>${e_(L.cfg.signal)}</b></span>` : ''}${race && race.callStatus ? `<span>status <b>${e_(String(race.callStatus).replace(/_/g, ' '))}</b></span>` : ''}</span>
      <span class="rm-sp"></span>
      <span class="rm-badge ${st.cls}">${st.label}</span>
      <button class="rm-x" type="button" aria-label="Close" title="Close (Esc)">×</button>`;
  }

  // ---- map
  function stateFeature(st) {
    const geo = G.GEO(); if (!geo) return null;
    let fips = null; try { fips = typeof STATE_FIPS !== 'undefined' ? STATE_FIPS[st] : null; } catch (e) { /* */ }
    return fips ? geo.find(f => String(f.id).padStart(2, '0') === fips) || null : null;
  }
  const projFor = st => st === 'AK' ? d3.geoMercator().rotate([150, 0]) : d3.geoMercator();
  async function renderMap(P, L) {
    const box = root.querySelector('.rm-map'), token = ++mapToken;
    const W = 220, H = 170, fill = statusOf(L.race).fill;
    try {
      const loads = [];
      if (!G.GEO() && G.fn('loadTopo')) loads.push(G.fn('loadTopo')().catch(() => null));
      if (P.office === 'house' && !G.DIST() && G.fn('loadDistricts')) loads.push(G.fn('loadDistricts')().catch(() => null));
      if (loads.length) { if (!box.innerHTML) box.innerHTML = '<div class="muted">loading map…</div>'; await Promise.all(loads); }
      if (token !== mapToken) return;
      const stF = stateFeature(P.state);
      if (P.office === 'senate' || P.office === 'governor') {
        if (!stF) { box.innerHTML = '<div class="muted">no state geometry</div>'; return; }
        const path = d3.geoPath(projFor(P.state).fitExtent([[6, 6], [W - 6, H - 6]], stF));
        box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${e_(P.state)} map"><path class="st solo" d="${path(stF)}" style="fill:${fill}"></path></svg><div class="rm-cap">${e_(STATE_NAME[P.state] || P.state)} · statewide</div>`;
        return;
      }
      const dist = G.DIST(), dF = dist ? dist.find(f => String(f.id) === P.id || (f.properties && `${f.properties.state}-${f.properties.district}` === P.id)) : null;
      if (!dF) { box.innerHTML = `<div class="muted">no district geometry${stF ? '' : ' / state geometry'}</div>`; return; }
      const ctx = stF || dF;
      const proj = projFor(P.state).fitExtent([[6, 6], [W - 6, H - 6]], ctx), path = d3.geoPath(proj);
      const [[x0, y0], [x1, y1]] = path.bounds(dF), dw = x1 - x0, dh = y1 - y0;
      const tiny = stF && Math.max(dw, dh) < 40;
      let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${e_(P.id)} map">${stF ? `<path class="st" d="${path(stF)}"></path>` : ''}<path class="ds" d="${path(dF)}" style="fill:${fill}"></path>`;
      if (tiny) {
        const pad = 3; svg += `<rect class="box" x="${(x0 - pad).toFixed(1)}" y="${(y0 - pad).toFixed(1)}" width="${(dw + 2 * pad).toFixed(1)}" height="${(dh + 2 * pad).toFixed(1)}"></rect>`;
      }
      svg += '</svg>';
      if (tiny) {
        const ip = d3.geoPath(projFor(P.state).fitExtent([[8, 8], [W - 8, H - 8]], dF));
        // state outline clipped to the inset gives local context (neighbouring coast/borders)
        svg += `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${e_(P.id)} zoomed" style="margin-top:6px"><defs><clipPath id="rm-clip"><rect width="${W}" height="${H}"></rect></clipPath></defs><g clip-path="url(#rm-clip)">${stF ? `<path class="st" d="${ip(stF)}"></path>` : ''}<path class="ds" d="${ip(dF)}" style="fill:${fill}"></path></g></svg><div class="rm-cap">top: ${e_(STATE_NAME[P.state] || P.state)} · bottom: ${e_(P.id)} zoomed</div>`;
      } else svg += `<div class="rm-cap">${e_(P.id)} within ${e_(STATE_NAME[P.state] || P.state)}</div>`;
      box.innerHTML = svg;
    } catch (err) { if (token === mapToken) box.innerHTML = `<div class="muted">map unavailable</div>`; }
  }

  async function renderWiki(P, L) {
    const w = root.querySelector('.rm-wiki'), links = root.querySelector('.rm-links'), id = P.id;
    const nytLink = L.race && L.race.url ? `<a href="${e_(L.race.url)}" target="_blank" rel="noopener">NYT results</a>` : '';
    const titles = wikiTitles(P);
    links.innerHTML = (titles.length ? `<a href="https://en.wikipedia.org/wiki/${encodeURIComponent(titles[0])}" target="_blank" rel="noopener">Wikipedia</a>` : '') + nytLink;
    w.className = 'rm-wiki muted'; w.textContent = 'loading description…';
    const res = await wikiFor(P);
    if (curId !== id) return;
    if (!res) { w.textContent = 'no description'; return; }
    w.className = 'rm-wiki'; w.textContent = trimBoilerplate(res.extract);
    links.innerHTML = `<a href="${e_(res.url)}" target="_blank" rel="noopener">Wikipedia</a>` + nytLink;
  }

  // ---- right column sections
  const kv = pairs => `<div class="kv">${pairs.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join('')}</div>`;
  const sec = (title, note, body) => `<h4>${title}${note ? ` <small>${note}</small>` : ''}</h4>${body}`;

  function secCandidates(race) {
    const cs = race && Array.isArray(race.candidates) ? race.candidates.slice() : [];
    if (!cs.length) return sec('CANDIDATES', '', `<div class="muted">—</div>`);
    cs.sort((a, b) => (b.votes || 0) - (a.votes || 0));
    const rows = cs.map(c => `<tr class="${c.won ? 'win' : ''}"><td class="nm">${esc_(c.name || c.last || '—')}${c.incumbent ? ' <span class="dim" title="incumbent">*</span>' : ''}</td><td>${party(c.party)}</td><td>${int(c.votes)}</td><td>${pct(c.pct)}</td><td>${c.won ? '<span class="over">✓ WON</span>' : c.leader ? '<span class="dim">▲ lead</span>' : ''}</td></tr>`).join('');
    return sec('CANDIDATES', race.uncontested ? 'uncontested · * incumbent' : '* incumbent', `<table><thead><tr><th>name</th><th>pty</th><th>votes</th><th>pct</th><th></th></tr></thead><tbody>${rows}</tbody></table>`);
  }
  function secCount(L) {
    const race = L.race || {};
    const live = tryFn('liveMarginFor', L.row) ?? (has(race.liveMargin) ? race.liveMargin : null);
    const m24 = tryFn('margin2024For', L.row) ?? (has(race.margin2024) ? race.margin2024 : null);
    const liveShown = has(live) ? live : null;
    const swing = has(liveShown) && has(m24) ? liveShown - m24 : null;
    const ev = has(race.eevp) ? pct(race.eevp, 0) : DASH;
    return sec('COUNT', race.providerUpdatedAt ? `updated ${e_(agoTxt(race.providerUpdatedAt))}` : '', kv([
      ['exp. vote in', ev], ['precincts', has(race.precinctsReporting) || has(race.precinctsTotal) ? `${int(race.precinctsReporting)}/${int(race.precinctsTotal)}` : DASH],
      ['total votes', int(race.totalVotes)], ['expected', int(race.expectedVotes)],
      ['live D−R', margin(liveShown)], ['2024 pres', margin(m24)],
      ['swing vs 24', over(swing)], ['provider at', race.providerUpdatedAt ? e_(new Date(race.providerUpdatedAt).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET') : DASH],
    ]));
  }
  function secMarkets(P, L) {
    const s = G.S(), seats = G.SEATS();
    const m = seats && seats.markets ? seats.markets[P.id] || null : null;
    const kb = s && s.kalshi && s.kalshi.races ? s.kalshi.races[P.id] || null : null;
    const pb = s && s.polymarket && s.polymarket.races ? s.polymarket.races[P.id] || null : null;
    const kD = kb && has(kb.pD) ? kb.pD : m && has(m.kD) ? m.kD : null;
    const pD = pb && has(pb.pD) ? pb.pD : m && has(m.pD) ? m.pD : null;
    const kVol = kb && has(kb.volume) ? kb.volume : m ? m.kVol : null;
    const pVol = pb && has(pb.volume) ? pb.volume : m ? m.pVol : null;
    const dp = v => has(v) ? `<span class="${v >= 50 ? 'd' : 'r'}">${(+v).toFixed(1)}%</span>` : DASH;
    const avg = has(kD) && has(pD) ? (kD + pD) / 2 : has(kD) ? kD : pD;
    const pairs = [['Kalshi D', dp(kD)], ['Poly D', dp(pD)], ['K vol', usd(kVol)], ['P vol', usd(pVol)], ['avg D', dp(avg)], ['K−P spread', has(kD) && has(pD) ? (kD - pD > 0 ? '+' : '') + (kD - pD).toFixed(1) : DASH]];
    if (kb) pairs.push(['K bid', cents(kb.bid)], ['K ask', cents(kb.ask)], ['K last', cents(kb.last)], ['K bid/ask', has(kb.bid) && has(kb.ask) ? ((kb.ask - kb.bid) * 100).toFixed(1) + '¢' : DASH]);
    if (pb && pb.D) pairs.push(['P D bid', cents(pb.D.bid)], ['P D ask', cents(pb.D.ask)], ['P D last', cents(pb.D.last)], ['P R', dp(pb.pR)]);
    return sec('MARKETS', L.cfg ? 'bellwether · D-win contract' : 'D win probability', kv(pairs));
  }
  function secPolls(L) {
    const pl = G.S() ? tryFn('pollFor', L.row) : null;
    if (!pl) return sec('POLLS', '', `<div class="muted">— no polls</div>`);
    const list = Array.isArray(pl.polls) ? pl.polls.slice().sort((a, b) => String(b.endDate || '').localeCompare(String(a.endDate || ''))).slice(0, 8) : [];
    const head = kv([['average', margin(pl.margin)], ['n', int(pl.n)], ['window', has(pl.windowDays) ? pl.windowDays + 'd' : DASH], ['latest', e_(pl.latestEnd || '—')], ['dem', pct(pl.dem)], ['rep', pct(pl.rep)]]);
    const rows = list.map(p => `<tr><td class="nm">${esc_(p.pollster || '—')}</td><td>${e_(p.endDate || '—')}</td><td>${has(p.sampleSize) ? int(p.sampleSize) + (p.population ? ' ' + e_(p.population) : '') : DASH}</td><td class="d">${has(p.dem) ? (+p.dem).toFixed(1) : DASH}</td><td class="r">${has(p.rep) ? (+p.rep).toFixed(1) : DASH}</td><td>${margin(p.margin)}</td></tr>`).join('');
    return sec('POLLS', `last ${list.length}`, head + (rows ? `<table style="margin-top:4px"><thead><tr><th>pollster</th><th>end</th><th>sample</th><th>dem</th><th>rep</th><th>margin</th></tr></thead><tbody>${rows}</tbody></table>` : ''));
  }
  function secSpend(L) {
    const sp = tryFn('spendFor', L.row);
    if (!sp) return sec('SPENDING', 'FEC', `<div class="muted">—</div>`);
    const share = has(sp.totalD) && has(sp.totalR) && sp.totalD + sp.totalR > 0 ? sp.totalD / (sp.totalD + sp.totalR) * 100 : null;
    return sec('SPENDING', 'FEC · candidate committees + independent expenditures', kv([
      ['cand D', `<span class="d">${usd(sp.candD)}</span>`], ['cand R', `<span class="r">${usd(sp.candR)}</span>`],
      ['outside D', `<span class="d">${usd(sp.ieD)}</span>`], ['outside R', `<span class="r">${usd(sp.ieR)}</span>`],
      ['total D', `<span class="d">${usd(sp.totalD)}</span>`], ['total R', `<span class="r">${usd(sp.totalR)}</span>`],
      ['total', usd(sp.total)], ['D share', share === null ? DASH : share.toFixed(0) + '%'],
    ]));
  }
  function secCounties(L) {
    const cs = L.nytB && Array.isArray(L.nytB.counties) ? L.nytB.counties.slice() : null;
    if (!cs || !cs.length) return '';
    cs.sort((a, b) => (b.expectedVotes || 0) - (a.expectedVotes || 0));
    const rows = cs.map(c => `<tr><td class="nm">${esc_(c.name || c.fips || '—')}</td><td>${pct(c.eevp, 0)}</td><td>${int(c.totalVotes)}</td><td>${int(c.expectedVotes)}</td><td>${margin(c.totalVotes ? c.liveMargin : null)}</td></tr>`).join('');
    return sec('COUNTIES', `${cs.length} · by expected vote`, `<div class="rm-scroll"><table><thead><tr><th>county</th><th>% in</th><th>votes</th><th>expected</th><th>live D−R</th></tr></thead><tbody>${rows}</tbody></table></div>`);
  }

  function safe(fn, title) { try { return fn(); } catch (err) { return sec(title, '', `<div class="muted">—</div>`); } }
  function renderData() {
    if (!root || !curP) return;
    const P = curP, L = lookup(P);
    const hdr = root.querySelector('.rm-hdr');
    try { hdr.innerHTML = renderHeader(P, L); } catch (err) { hdr.innerHTML = `<span class="rm-id" id="rm-title">${e_(P.id)}</span><span class="rm-sp"></span><button class="rm-x" type="button" aria-label="Close">×</button>`; }
    const right = root.querySelector('.rm-right'), sc = right.scrollTop;
    right.innerHTML = [
      safe(() => secCandidates(L.race), 'CANDIDATES'), safe(() => secCount(L), 'COUNT'), safe(() => secMarkets(P, L), 'MARKETS'),
      safe(() => secPolls(L), 'POLLS'), safe(() => secSpend(L), 'SPENDING'), safe(() => secCounties(L), 'COUNTIES'),
    ].join('');
    right.scrollTop = sc;
    // refresh the map fill when call status changes (geometry is cached by d3 path strings; cheap)
    const fill = statusOf(L.race).fill;
    root.querySelectorAll('.rm-map path.ds' + (P.office !== 'house' ? ', .rm-map path.st.solo' : '')).forEach(p => { p.style.fill = fill; });
    return L;
  }

  function openRaceModal(id) {
    ensureRoot();
    const P = parseId(id);
    const already = root.classList.contains('open');
    if (!already) lastFocus = document.activeElement;
    curId = P.id; curP = P;
    root.querySelector('.rm-map').innerHTML = '';
    root.classList.add('open');
    const L = renderData() || lookup(P);
    renderMap(P, L);
    renderWiki(P, L);
    clearInterval(timer); timer = setInterval(renderData, REFRESH_MS);
    const x = root.querySelector('.rm-x'); if (x) x.focus({ preventScroll: true });
    root.querySelector('.rm-box').scrollTop = 0;
  }
  function closeRaceModal() {
    clearInterval(timer); timer = null; curId = null; curP = null; mapToken++;
    if (!root) return;
    root.classList.remove('open');
    // never hand focus back into the race table: a focused link there would pause table renders
    if (lastFocus && lastFocus.focus && !(lastFocus.closest && lastFocus.closest('#racebody'))) { try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* */ } }
    else if (document.activeElement && document.activeElement.blur) { try { document.activeElement.blur(); } catch (e) { /* */ } }
    lastFocus = null;
  }
  window.openRaceModal = openRaceModal;
  window.closeRaceModal = closeRaceModal;
})();
