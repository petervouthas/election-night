// Predictions game (Senate only): leaderboard, your entry (seat totals + generic ballot), and a Senate pick map (state tiles) + race list.
// Exposes window.renderGame(container). The host calls it when the Game panel is shown and every 15 s while visible.
// Exposes window.Game = { reload, senateIds, favorite, raceById, fmtLockET, lockInstant, mkt } for onboard.js.
// Reads page globals S, SEATS, RATING_LABEL, marketProb, esc, store, ago (all optional; nothing throws without them).
(function () {
  'use strict';
  const POLL_MS = 15e3, SAVE_DEBOUNCE_MS = 600;
  const GM = {
    container: null, data: null, dataAt: 0, fetching: null, fetchErr: null,
    me: null, entry: null, entryErr: null, entryLoading: false,
    save: { status: 'idle', t: 0, err: null }, saveTimer: null, saving: false, dirty: false,
    viewId: null, mapSig: '', listSig: '', info: null,
    editingName: false, joinErr: null, lockedSeen: null, entrySig: '',
  };

  // ---- safe access to page globals (declared with let/const in index.html, so not on window)
  const G = {
    S() { try { return typeof S !== 'undefined' ? S : null; } catch (e) { return null; } },
    SEATS() { try { return typeof SEATS !== 'undefined' ? SEATS : null; } catch (e) { return null; } },
    RL() { try { return typeof RATING_LABEL !== 'undefined' ? RATING_LABEL || {} : {}; } catch (e) { return {}; } },
  };
  const h = s => { try { if (typeof esc === 'function') return esc(s); } catch (e) {} return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); };
  const st = {
    get(k) { try { if (typeof store !== 'undefined') return store.get(k); } catch (e) {} try { const v = localStorage.getItem('en26:' + k); return v === null ? null : JSON.parse(v); } catch (e) { return null; } },
    set(k, v) { try { if (typeof store !== 'undefined') return store.set(k, v); } catch (e) {} try { if (v === null) localStorage.removeItem('en26:' + k); else localStorage.setItem('en26:' + k, JSON.stringify(v)); } catch (e) {} },
  };
  const isNum = v => typeof v === 'number' && isFinite(v);
  const report = msg => { try { if (typeof clientError === 'function') clientError('game', msg); else console.warn('game:', msg); } catch (e) {} };
  const hhmm = t => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const isSen = id => /^[A-Z]{2}-Sen$/.test(id);
  const senOnly = picks => { const o = {}; for (const k in picks || {}) if (isSen(k) && (picks[k] === 'D' || picks[k] === 'R')) o[k] = picks[k]; return o; };

  // ---- races (Senate only)
  function raceById(id) {
    const SE = G.SEATS(); if (!SE || !id) return null;
    if (/-Sen$/.test(id)) return (SE.senate || []).find(r => `${r.state}-Sen` === id) || null;
    if (/-Gov$/.test(id)) return (SE.governor || []).find(r => `${r.state}-Gov` === id) || null;
    return null;
  }
  function senateIds() {
    const SE = G.SEATS(); if (!SE) return [];
    const ids = []; for (const r of SE.senate || []) { const id = `${r.state}-Sen`; if (!ids.includes(id)) ids.push(id); }
    return ids.sort();
  }
  function mkt(id) {
    try { if (typeof marketProb === 'function' && G.S()) { const m = marketProb(id); if (m && isNum(m.v)) return m.v; } } catch (e) {}
    const SE = G.SEATS(), m = SE && SE.markets ? SE.markets[id] : null;
    if (!m) return null;
    const k = isNum(m.kD) ? m.kD : null, p = isNum(m.pD) ? m.pD : null;
    return k !== null && p !== null ? (k + p) / 2 : (k ?? p);
  }
  function favorite(id) {
    const v = mkt(id);
    if (isNum(v) && v !== 50) return v > 50 ? 'D' : 'R';
    const r = raceById(id), rt = r && r.rating;
    if (rt && /dem$/.test(rt)) return 'D'; if (rt && /rep$/.test(rt)) return 'R';
    if (r && r.uncontested && r.candidates && r.candidates[0]) { const p = r.candidates[0].party; if (p === 'D' || p === 'R') return p; }
    const inc = r && (r.candidates || []).find(c => c.incumbent);
    return inc && (inc.party === 'D' || inc.party === 'R') ? inc.party : null;
  }
  const mktTag = id => { const v = mkt(id); if (!isNum(v)) return '<span class="muted">mkt —</span>'; return v >= 50 ? `<span class="d">mkt D ${Math.round(v)}</span>` : `<span class="r">mkt R ${Math.round(100 - v)}</span>`; };
  const ratingShort = rt => ({ 'tossup': 'Toss-up', 'lean-dem': 'Lean D', 'lean-rep': 'Lean R', 'likely-dem': 'Likely D', 'likely-rep': 'Likely R', 'solid-dem': 'Solid D', 'solid-rep': 'Solid R' }[rt] || G.RL()[rt] || '');
  const ratingRank = rt => !rt ? 2.5 : rt === 'tossup' ? 0 : /^lean/.test(rt) ? 1 : /^likely/.test(rt) ? 2 : /^solid/.test(rt) ? 3 : 2.5;
  const cands = r => {
    if (!r || !r.candidates) return '';
    const pick = party => r.candidates.filter(c => c.party === party).sort((a, b) => (b.incumbent ? 1 : 0) - (a.incumbent ? 1 : 0) || (b.votes || 0) - (a.votes || 0))[0];
    const two = [pick('D'), pick('R')].filter(Boolean);
    return two.map(c => `<span class="${c.party === 'D' ? 'd' : 'r'}">${h(c.last)}${c.incumbent ? '*' : ''}</span>`).join(' v ');
  };
  function sortedSenate() {
    return senateIds().map(id => ({ id, r: raceById(id) })).sort((a, b) => (ratingRank(a.r && a.r.rating) - ratingRank(b.r && b.r.rating)) || (a.id < b.id ? -1 : 1));
  }

  // ---- lock time
  function lockInstant(lockET) {
    const [hh, mm] = String(lockET || '19:00').split(':').map(Number), want = `${String(hh).padStart(2, '0')}:${String(mm || 0).padStart(2, '0')}`;
    for (const off of [5, 4]) {
      const t = Date.UTC(2026, 10, 3, hh + off, mm || 0);
      try { if (new Date(t).toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(11, 16) === want) return t; } catch (e) { return t; }
    }
    return Date.UTC(2026, 10, 3, hh + 5, mm || 0);
  }
  const fmtLockET = lockET => { const [hh, mm] = String(lockET || '19:00').split(':').map(Number); return `${(hh % 12) || 12}:${String(mm || 0).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'} ET`; };
  function fmtLeft(ms) {
    const m = Math.max(0, Math.round(ms / 60e3)), d = Math.floor(m / 1440), hr = Math.floor(m % 1440 / 60), mi = m % 60;
    return d ? `${d}d ${hr}h` : hr ? `${hr}h ${mi}m` : `${mi}m`;
  }
  const locked = () => !!(GM.data && GM.data.locked);

  // ---- network
  async function api(method, url, body) {
    const r = await fetch(url, method === 'GET' ? { cache: 'no-store' } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) { const e = new Error((j && j.error) || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return j;
  }
  function fetchGame(force) {
    if (GM.fetching) return GM.fetching;
    if (!force && GM.dataAt && Date.now() - GM.dataAt < POLL_MS - 2e3) return Promise.resolve(false);
    GM.dataAt = Date.now();
    GM.fetching = api('GET', '/api/game').then(j => { GM.data = j; GM.fetchErr = null; return true; })
      .catch(e => { GM.fetchErr = e.message; report('/api/game: ' + e.message); return false; })
      .finally(() => { GM.fetching = null; if (visible()) paint(); });
    return GM.fetching;
  }
  async function loadEntry() {
    if (!GM.me || GM.entryLoading) return;
    GM.entryLoading = true; GM.entryErr = null;
    try {
      const j = await api('GET', `/api/game/me?id=${encodeURIComponent(GM.me.id)}&token=${encodeURIComponent(GM.me.token)}`);
      GM.entry = { houseD: j.houseD ?? null, senateD: j.senateD ?? null, gb: j.gb ?? null, picks: senOnly(j.picks) };
      if ((j.name && j.name !== GM.me.name) || (j.home && !GM.me.home)) { GM.me.name = j.name || GM.me.name; GM.me.home = GM.me.home || j.home; st.set('game:me', GM.me); }
      if (j.updatedAt) GM.save = { status: 'saved', t: j.updatedAt, err: null };
    } catch (e) {
      if (e.status === 403) { GM.joinErr = 'Your saved entry was not found on the server; join again.'; GM.me = null; st.set('game:me', null); GM.entry = null; }
      else GM.entryErr = e.message;
    } finally { GM.entryLoading = false; GM.entrySig = ''; GM.mapSig = ''; GM.listSig = ''; if (visible()) paint(); }
  }
  function scheduleSave() {
    if (!GM.me || !GM.entry || locked()) return;
    GM.dirty = true; GM.save.status = 'pending'; renderSaveState();
    clearTimeout(GM.saveTimer); GM.saveTimer = setTimeout(doSave, SAVE_DEBOUNCE_MS);
  }
  async function doSave(extra) {
    if (!GM.me || !GM.entry) return;
    if (GM.saving) { GM.dirty = true; if (extra) GM.pendingExtra = Object.assign(GM.pendingExtra || {}, extra); return; }
    GM.saving = true; GM.dirty = false; GM.save.status = 'saving'; renderSaveState();
    try {
      const body = Object.assign({ id: GM.me.id, token: GM.me.token, houseD: GM.entry.houseD, senateD: GM.entry.senateD, gb: GM.entry.gb, picks: senOnly(GM.entry.picks) }, extra || {});
      const j = await api('POST', '/api/game/entry', body);
      GM.save = { status: 'saved', t: (j.player && j.player.updatedAt) || Date.now(), err: null };
      if (j.player && j.player.name && j.player.name !== GM.me.name) { GM.me.name = j.player.name; st.set('game:me', GM.me); }
      if (extra && extra.name && j.player && j.player.name !== extra.name) GM.save.err = 'that name is taken; kept ' + j.player.name;
      if (extra && extra.zip && j.player && j.player.home) { GM.me.home = j.player.home; st.set('game:me', GM.me); GM.zipErr = null; }
      fetchGame(true);
    } catch (e) {
      GM.save = { status: 'error', t: Date.now(), err: e.message };
      if (extra && extra.zip && e.status === 400) { GM.zipErr = e.message || 'zip code not recognized'; GM.editingName = true; GM.save = { status: 'idle', t: 0, err: null }; }
      if (e.status === 423 && GM.data) GM.data.locked = true;
    } finally {
      GM.saving = false; renderSaveState();
      if (GM.dirty && GM.save.status !== 'error') { const x = GM.pendingExtra; GM.pendingExtra = null; doSave(x); }
      if (extra && (extra.name || extra.zip)) { GM.entrySig = ''; GM.mapSig = ''; paint(); }
    }
  }
  async function join(name, zip) {
    GM.joinErr = null;
    if (!/^\d{5}$/.test(String(zip || '').trim())) { GM.joinErr = 'enter your 5-digit hometown zip code'; GM.entrySig = ''; paint(); return; }
    try {
      const j = await api('POST', '/api/game/register', { name, zip: String(zip).trim() });
      GM.me = { id: j.id, token: j.token, name: j.name, home: j.home || null }; st.set('game:me', GM.me);
      GM.entry = { houseD: null, senateD: null, gb: null, picks: {} }; GM.save = { status: 'idle', t: 0, err: null };
      GM.viewId = j.id; fetchGame(true);
    } catch (e) { GM.joinErr = e.status === 409 || e.status === 423 || e.status === 400 || e.status === 429 ? e.message : 'could not join: ' + e.message; }
    GM.entrySig = ''; GM.mapSig = ''; GM.listSig = ''; paint();
  }

  // ---- picks
  function setPick(id, v) {
    if (!GM.entry || locked() || !isSen(id)) return;
    if (v === 'D' || v === 'R') GM.entry.picks[id] = v; else delete GM.entry.picks[id];
    syncPickButtons(id); updateMap(); renderMapSummary(); scheduleSave();
  }
  const cyclePick = id => { const c = GM.entry && GM.entry.picks[id]; setPick(id, !c ? 'D' : c === 'D' ? 'R' : null); };
  function fillFromMarkets() {
    if (!GM.entry || locked()) return 0;
    let n = 0;
    for (const id of senateIds()) { if (GM.entry.picks[id]) continue; const f = favorite(id); if (f) { GM.entry.picks[id] = f; n++; } }
    syncPickButtons(); updateMap(); renderMapSummary(); scheduleSave(); return n;
  }

  // ---- skeleton
  function visible() { const c = GM.container; return !!(c && c.isConnected && c.offsetParent !== null && !document.hidden); }
  function build(container) {
    GM.container = container; GM.mapSig = ''; GM.entrySig = ''; GM.listSig = '';
    container.classList.add('gm');
    container.innerHTML = `
      <div class="gm-wrap">
        <section class="gm-sec gm-board-sec"><div class="gm-h">LEADERBOARD<span class="gm-sp"></span><span class="muted gm-upd"></span></div><div class="gm-board"></div></section>
        <section class="gm-sec gm-entry-sec"><div class="gm-h">YOUR ENTRY<span class="gm-sp"></span><span class="gm-save muted"></span></div><div class="gm-entry"></div></section>
        <section class="gm-sec gm-map-sec"><div class="gm-h"><span class="gm-map-title">SENATE MAP</span><span class="gm-sp"></span><span class="gm-mapback"></span></div>
          <div class="gm-mapctl"></div><div class="gm-seatline"></div>
          <div class="gm-mapwrap"><div class="muted gm-pad">waiting for race data…</div></div>
          <div class="gm-msum muted"></div>
          <div class="gm-info muted">Tap a state for details.</div>
          <div class="gm-msg muted"></div>
          <div class="gm-picks"></div></section>
      </div>`;
    const q = s => container.querySelector(s);
    q('.gm-board').addEventListener('click', onBoardClick);
    q('.gm-board').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { const tr = e.target.closest && e.target.closest('tr[data-pid]'); if (tr) { e.preventDefault(); selectPlayer(tr.dataset.pid); } } });
    const ent = q('.gm-entry');
    ent.addEventListener('click', onEntryClick);
    ent.addEventListener('input', onEntryInput);
    ent.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      if (e.target.matches('.gm-joinname, .gm-joinzip')) { e.preventDefault(); const nm = (GM.container.querySelector('.gm-joinname') || {}).value || '', zp = (GM.container.querySelector('.gm-joinzip') || {}).value || ''; if (nm.trim()) join(nm.trim(), zp); }
      if (e.target.matches('.gm-nameedit')) { e.preventDefault(); const z = GM.container.querySelector('.gm-zipedit'); if (z) z.focus(); }
      if (e.target.matches('.gm-zipedit')) { e.preventDefault(); commitName(); }
    });
    ent.addEventListener('keydown', e => { if (e.key === 'Escape' && GM.editingName) { e.preventDefault(); e.stopPropagation(); GM.editingName = false; GM.zipErr = null; GM.entrySig = ''; renderEntry(); } });
    q('.gm-mapctl').addEventListener('click', onMapCtlClick);
    q('.gm-mapback').addEventListener('click', e => { if (e.target.closest('button')) { GM.viewId = GM.me ? GM.me.id : null; GM.mapSig = ''; GM.listSig = ''; paint(); } });
    q('.gm-mapwrap').addEventListener('click', e => { const g = e.target.closest && e.target.closest('g.tile.has'); if (g) onSeatTap(`${g.dataset.st}-Sen`); });
    q('.gm-mapwrap').addEventListener('keydown', e => { if (e.key !== 'Enter' && e.key !== ' ') return; const g = e.target.closest && e.target.closest('g.tile.has'); if (g) { e.preventDefault(); onSeatTap(`${g.dataset.st}-Sen`); } });
    q('.gm-mapwrap').addEventListener('pointerover', e => { if (e.pointerType !== 'mouse') return; const g = e.target.closest && e.target.closest('g.tile.has'); if (g) showInfo(`${g.dataset.st}-Sen`); });
    q('.gm-info').addEventListener('click', e => { const a = e.target.closest('[data-modal]'); if (a && window.openRaceModal) { try { window.openRaceModal(a.dataset.modal); } catch (err) { report('modal: ' + err.message); } } });
    q('.gm-picks').addEventListener('click', onListClick);
  }

  // ---- leaderboard
  function renderBoard() {
    const root = GM.container.querySelector('.gm-board'), d = GM.data;
    GM.container.querySelector('.gm-upd').textContent = GM.fetchErr ? 'offline · ' + GM.fetchErr : d ? 'updated ' + hhmm(d.updatedAt || Date.now()) : '';
    if (!d) { root.innerHTML = `<div class="muted gm-pad">${GM.fetchErr ? 'could not load the game: ' + h(GM.fetchErr) : 'waiting for data…'}</div>`; return; }
    const c = d.current || {}, lockAt = lockInstant(d.lockET), now = Date.now();
    const banner = d.locked ? `<div class="gm-lock is-locked"><b>Locked</b> · scoring live</div>`
      : `<div class="gm-lock"><b>Entries lock at ${h(fmtLockET(d.lockET))}</b>${lockAt > now ? ' · ' + fmtLeft(lockAt - now) + ' left' : ''}</div>`;
    const nSen = senateIds().length || 35;
    const bench = `<div class="gm-bench">Live: House <span class="d">D ${c.houseDLead ?? '—'}</span> called+leading · Senate <span class="d">D ${c.senateDLead ?? '—'}</span> · ${c.senateCalled || 0} of ${nSen} Senate races called</div>`;
    const houseLive = (c.houseDLead || 0) + (c.houseRLead || 0) > 0;
    const senLive = (c.senateCalled || 0) > 0 || ((c.senateDLead || 0) - (c.senateD || 0) + (c.senateRLead || 0) - (c.senateR || 0)) > 0;
    const errSpan = (err, show) => !show || !isNum(err) ? '' : ` <small class="${err <= 5 ? 'over' : 'under'}" title="off by ${err} from live called+leading">±${err}</small>`;
    const players = d.players || [];
    if (!players.length) { root.innerHTML = banner + bench + `<div class="muted gm-pad">No players yet.${d.locked ? '' : ' Be the first: tap “Join the game”.'}</div>`; return; }
    const meId = GM.me && GM.me.id;
    const rows = players.map(p => {
      const cls = [p.id === meId ? 'gm-me' : '', p.id === GM.viewId ? 'gm-sel' : ''].join(' ');
      const nSenPicks = Object.keys(p.picks || {}).filter(isSen).length;
      return `<tr data-pid="${h(p.id)}" class="${cls}" tabindex="0">
        <td class="l num">${p.rank}</td>
        <td class="l gm-name" title="${p.home ? h(p.home.city + ', ' + p.home.state + (p.home.county ? ' (' + p.home.county + ')' : '') + (p.home.district ? ' · ' + p.home.district : '')) : ''}">${h(p.name)}${p.id === meId ? ' <small class="muted">you</small>' : ''}${p.home ? ` <small class="muted">${h(p.home.city)}, ${h(p.home.state)}</small>` : ''}</td>
        <td class="num gm-score">${p.correct}</td>
        <td class="num">${p.wrong ? `<span class="under">${p.wrong}</span>` : '<span class="muted">0</span>'}</td>
        <td class="num">${p.pending}${p.leadingRight || p.leadingWrong ? ` <small class="over" title="leading the way they picked">${p.leadingRight}</small><small class="gm-sl">/</small><small class="under" title="trailing the way they picked">${p.leadingWrong}</small>` : ''}</td>
        <td class="num">${isNum(p.accuracy) ? p.accuracy.toFixed(0) + '%' : '<span class="muted">—</span>'}</td>
        <td class="num">${isNum(p.houseD) ? p.houseD : '<span class="muted">—</span>'}${errSpan(p.houseErr, houseLive)}</td>
        <td class="num">${isNum(p.senateD) ? p.senateD : '<span class="muted">—</span>'}${errSpan(p.senateErr, senLive)}</td>
        <td class="num">${isNum(p.gb) ? (p.gb > 0 ? `<span class="d">D+${p.gb}</span>` : p.gb < 0 ? `<span class="r">R+${-p.gb}</span>` : 'EVEN') : '<span class="muted">—</span>'}</td>
        <td class="num muted">${nSenPicks}</td></tr>`;
    }).join('');
    root.innerHTML = banner + bench + `<div class="gm-tblwrap"><table class="gm-tbl"><thead><tr>
      <th class="l">#</th><th class="l">name</th><th title="correct Senate calls">score</th><th>wrong</th><th title="pending · leading right / leading wrong">pending</th><th>acc</th><th title="predicted House D seats ± error vs live called+leading">House D</th><th title="predicted Senate D seats ± error vs live">Sen D</th><th title="generic ballot prediction">GB</th><th>picks</th>
      </tr></thead><tbody>${rows}</tbody></table></div><div class="muted gm-hint">Tap a player to see their Senate map.</div>`;
  }
  function onBoardClick(e) { const tr = e.target.closest('tr[data-pid]'); if (tr) selectPlayer(tr.dataset.pid); }
  function selectPlayer(pid) {
    GM.viewId = pid; GM.mapSig = ''; GM.listSig = ''; paint();
    try { if (window.matchMedia('(max-width: 900px)').matches) GM.container.querySelector('.gm-map-sec').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
  }

  // ---- entry (name + seat totals)
  function renderEntry() {
    const root = GM.container.querySelector('.gm-entry'), d = GM.data, lk = locked();
    const sig = [GM.me ? GM.me.id + GM.me.name : '-', !!GM.entry, GM.entryLoading, GM.entryErr, lk, GM.editingName, GM.joinErr, GM.zipErr, GM.me && GM.me.home && GM.me.home.zip, d ? 1 : 0, typeof window.openOnboarding].join('|');
    if (sig === GM.entrySig) return;
    const a = document.activeElement; if (a && root.contains(a) && a.tagName === 'INPUT' && GM.entrySig) return;   // never rebuild under a focused input
    GM.entrySig = sig;
    if (!GM.me) {
      if (lk) { root.innerHTML = `<div class="gm-pad muted">Entries locked at ${h(fmtLockET(d && d.lockET))}. Follow along on the leaderboard.</div>`; return; }
      if (typeof window.openOnboarding === 'function') {
        root.innerHTML = `<div class="gm-pad gm-joinbox"><div class="dim">Predict the Senate, the House and the national vote, then climb the board all night.</div>
          <button class="gm-btn gm-joincta">Join the game</button>
          ${GM.joinErr ? `<div class="gm-err">${h(GM.joinErr)}</div>` : ''}</div>`;
        return;
      }
      root.innerHTML = `<div class="gm-pad"><div class="dim">Pick the Senate winners, predict the seat totals, climb the board.</div>
          <div class="gm-join"><input class="gm-joinname" type="text" maxlength="24" placeholder="your name" autocomplete="nickname" enterkeyhint="next"><input class="gm-joinzip" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" placeholder="hometown zip" autocomplete="postal-code" enterkeyhint="go"><button class="gm-btn gm-joinbtn">Join</button></div>
          <div class="muted gm-small">Your hometown zip (where you're from) puts your House district and state races on the Hometowns list.</div>
          ${GM.joinErr ? `<div class="gm-err">${h(GM.joinErr)}</div>` : ''}</div>`;
      return;
    }
    if (!GM.entry) { root.innerHTML = `<div class="gm-pad muted">${GM.entryErr ? `could not load your entry: ${h(GM.entryErr)} <button class="gm-btn gm-retry">retry</button>` : 'loading your entry…'}</div>`; return; }
    const e = GM.entry, dis = lk ? ' disabled' : '';
    const nameRow = GM.editingName && !lk
      ? `<span class="gm-editbox"><input class="gm-nameedit" type="text" maxlength="24" value="${h(GM.me.name)}" placeholder="your name" aria-label="name" enterkeyhint="next"><input class="gm-zipedit" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" value="${h(GM.zipErr && GM.zipDraft ? GM.zipDraft : (GM.me.home && GM.me.home.zip) || '')}" placeholder="hometown zip" aria-label="hometown zip" autocomplete="postal-code" enterkeyhint="done"><button class="gm-btn gm-namesave">save</button><button class="gm-link gm-namecancel">cancel</button></span>${GM.zipErr ? `<div class="gm-err">${h(GM.zipErr)}</div>` : ''}`
      : `<b class="gm-myname">${h(GM.me.name)}</b>${GM.me.home ? ` <span class="muted gm-small">${h(GM.me.home.city)}, ${h(GM.me.home.state)}${GM.me.home.district ? ' · ' + h(GM.me.home.district) : ''}</span>` : ''}${lk ? '' : '<button class="gm-link gm-nameedit-btn" title="Change your name or hometown zip">edit</button>'}`;
    root.innerHTML = `
      <div class="gm-who">${nameRow}<span class="gm-sp"></span>${lk ? '<span class="under">locked</span>' : ''}</div>
      ${lk ? `<div class="gm-lockmsg">Entries locked at ${h(fmtLockET(d && d.lockET))}. Your entry is final; scoring is live.</div>` : ''}
      <div class="gm-nums">
        <label><span>House D seats</span><input type="number" class="gm-in" data-k="houseD" min="0" max="435" step="1" inputmode="numeric" placeholder="0–435" value="${isNum(e.houseD) ? e.houseD : ''}"${dis}></label>
        <label><span>Senate D seats</span><input type="number" class="gm-in" data-k="senateD" min="0" max="100" step="1" inputmode="numeric" placeholder="0–100" value="${isNum(e.senateD) ? e.senateD : ''}"${dis}></label>
        <label><span>Generic ballot D−R</span><input type="number" class="gm-in" data-k="gb" min="-30" max="30" step="0.5" inputmode="decimal" placeholder="e.g. 3.5" value="${isNum(e.gb) ? e.gb : ''}"${dis}></label>
      </div>
      ${lk || typeof window.openOnboarding !== 'function' ? '' : '<div class="gm-acts"><button class="gm-btn gm-wizard">Step-by-step entry</button></div>'}`;
  }
  function myDetail() { const d = GM.data, me = GM.me; if (!d || !me) return null; const p = (d.players || []).find(x => x.id === me.id); return p ? p.detail : null; }
  function onEntryClick(e) {
    const t = e.target;
    if (t.closest('.gm-joincta') || t.closest('.gm-wizard')) { try { window.openOnboarding(); } catch (err) { report('onboarding: ' + err.message); } return; }
    if (t.closest('.gm-joinbtn')) { const inp = GM.container.querySelector('.gm-joinname'), zp = GM.container.querySelector('.gm-joinzip'); const v = inp ? inp.value.trim() : ''; if (v) join(v, zp ? zp.value : ''); else if (inp) inp.focus(); return; }
    if (t.closest('.gm-retry')) { loadEntry(); return; }
    if (t.closest('.gm-nameedit-btn')) { GM.editingName = true; GM.zipErr = null; GM.entrySig = ''; renderEntry(); const i = GM.container.querySelector('.gm-nameedit'); if (i) { i.focus(); i.select(); } return; }
    if (t.closest('.gm-namesave')) { commitName(); return; }
    if (t.closest('.gm-namecancel')) { GM.editingName = false; GM.zipErr = null; GM.entrySig = ''; renderEntry(); return; }
  }
  function commitName() {
    const ni = GM.container.querySelector('.gm-nameedit'), zi = GM.container.querySelector('.gm-zipedit');
    const v = String(ni ? ni.value : '').trim(), z = String(zi ? zi.value : '').trim();
    const extra = {};
    if (v && GM.me && v !== GM.me.name) extra.name = v;
    if (z && GM.me && z !== ((GM.me.home && GM.me.home.zip) || '')) {
      if (!/^\d{5}$/.test(z)) { GM.zipErr = 'enter a 5-digit zip code'; GM.entrySig = ''; renderEntry(); return; }
      if (/^(10[0-4]|11[0-6])\d{2}$/.test(z) && GM.nycOk !== z) { GM.nycOk = z; GM.zipDraft = z; GM.zipErr = "that's a New York City zip: use your hometown, where you're from, not where you live now. Press save again if NYC really is home."; GM.entrySig = ''; renderEntry(); return; }
      extra.zip = z; GM.zipDraft = z;
    }
    GM.editingName = false; GM.zipErr = null;
    if (Object.keys(extra).length && GM.me && !locked()) doSave(extra);
    GM.entrySig = ''; renderEntry();
  }
  function onEntryInput(e) {
    const k = e.target.dataset && e.target.dataset.k; if (!k || !GM.entry) return;
    const raw = e.target.value.trim();
    let v = raw === '' ? null : k === 'gb' ? parseFloat(raw) : parseInt(raw, 10);
    if (v !== null && !isFinite(v)) return;
    if (v !== null) v = k === 'houseD' ? Math.max(0, Math.min(435, v)) : k === 'senateD' ? Math.max(0, Math.min(100, v)) : Math.max(-30, Math.min(30, v));
    GM.entry[k] = v; scheduleSave();
  }
  function flash(msg) { const m = GM.container && GM.container.querySelector('.gm-msg'); if (!m) return; m.textContent = msg; clearTimeout(flash.t); flash.t = setTimeout(() => { m.textContent = ''; }, 4000); }
  function renderSaveState() {
    const el = GM.container && GM.container.querySelector('.gm-save'); if (!el) return;
    const s = GM.save;
    if (!GM.me) { el.textContent = ''; return; }
    el.className = 'gm-save ' + (s.status === 'error' || s.err ? 'under' : 'muted');
    el.textContent = s.status === 'saving' || s.status === 'pending' ? 'saving…' : s.status === 'error' ? 'not saved: ' + s.err : s.status === 'saved' ? `saved ${hhmm(s.t)}${s.err ? ' · ' + s.err : ''}` : '';
  }

  // ---- map + list (whoever is being viewed)
  const viewedPlayer = () => (GM.data && GM.viewId ? (GM.data.players || []).find(p => p.id === GM.viewId) : null);
  const ownView = () => !!(GM.me && (!GM.viewId || GM.viewId === GM.me.id));
  const editable = () => ownView() && !!GM.entry && !locked();
  function viewPicks() { if (ownView() && GM.entry) return GM.entry.picks; const p = viewedPlayer(); return p ? senOnly(p.picks) : {}; }
  function viewDetail() { if (editable()) return {}; if (ownView()) return myDetail() || {}; const p = viewedPlayer(); return p ? p.detail || {} : {}; }
  const RES = { 'correct': 1, 'wrong': 1, 'leading-right': 1, 'leading-wrong': 1 };

  function onSeatTap(id) { if (editable()) cyclePick(id); showInfo(id); }
  function showInfo(id) {
    const el = GM.container && GM.container.querySelector('.gm-info'); if (!el) return;
    GM.info = id;
    const r = raceById(id), pk = viewPicks()[id], det = viewDetail()[id];
    const who = ownView() ? 'your pick' : 'their pick';
    const status = r ? (r.winnerParty ? `called <b class="${r.winnerParty === 'D' ? 'd' : r.winnerParty === 'R' ? 'r' : ''}">${h(r.winnerParty)}</b>` : r.totalVotes && r.leaderParty ? `${h(r.leaderParty)} leads${isNum(r.eevp) ? ' · ' + r.eevp + '% in' : ''}` : 'no result yet') : '';
    el.innerHTML = `<b>${h(id)}</b> ${cands(r)} <span class="muted">${h(ratingShort(r && r.rating))}</span> · ${mktTag(id)} · ${who} ${pk ? `<b class="${pk === 'D' ? 'd' : 'r'}">${pk}</b>` : '<span class="muted">none</span>'}${RES[det] ? ` · <span class="${/right|correct/.test(det) ? 'over' : 'under'}">${h(det.replace('-', ' '))}</span>` : ''} · ${status}${window.openRaceModal ? ` · <a class="gm-link" data-modal="${h(id)}">details ›</a>` : ''}`;
  }
  function renderMapChrome() {
    const c = GM.container, own = ownView(), ed = editable(), p = viewedPlayer();
    c.querySelector('.gm-map-title').textContent = own ? (GM.me ? 'YOUR SENATE MAP' : 'SENATE MAP') : `${p ? p.name.toUpperCase() : 'PLAYER'}'S SENATE MAP`;
    c.querySelector('.gm-mapback').innerHTML = !own && GM.me ? '<button class="gm-btn gm-small">back to my map</button>' : '';
    const ctl = c.querySelector('.gm-mapctl');
    const ctlSig = `${ed}|${own}|${!!GM.me}`;
    if (ctl.dataset.sig !== ctlSig) {
      ctl.dataset.sig = ctlSig;
      ctl.innerHTML = ed ? `<span class="muted gm-tapnote">Tap a state: D → R → none</span><span class="gm-sp"></span><span class="gm-ctlbtns"><button class="gm-btn gm-fillall" title="Set every unpicked Senate race to the betting-market favorite">Fill from markets</button><button class="gm-btn gm-clear">Clear</button></span>`
        : own && !GM.me ? '<span class="muted">Join to fill in your own map. Tap a player on the leaderboard to see theirs.</span>' : '';
    }
    const line = c.querySelector('.gm-seatline');
    const pl = own ? (GM.me && GM.data ? (GM.data.players || []).find(x => x.id === GM.me.id) : null) : p;
    if (!pl) { line.innerHTML = ''; return; }
    const cur = (GM.data && GM.data.current) || {};
    const senLive = (cur.senateCalled || 0) > 0 || ((cur.senateDLead || 0) - (cur.senateD || 0) + (cur.senateRLead || 0) - (cur.senateR || 0)) > 0;
    const seatBit = (lab, v, live, err, on) => `${lab} <b class="d">D ${isNum(v) ? v : '—'}</b>${on && isNum(v) && isNum(live) ? ` <span class="muted">(live ${live}${isNum(err) ? `, <span class="${err <= 5 ? 'over' : 'under'}">off ${err}</span>` : ''})</span>` : ''}`;
    line.innerHTML = `<span class="dim">${h(pl.name)}:</span> ${seatBit('House', pl.houseD, cur.houseDLead, pl.houseErr, (cur.houseDLead || 0) + (cur.houseRLead || 0) > 0)} · ${seatBit('Senate', pl.senateD, cur.senateDLead, pl.senateErr, senLive)}${isNum(pl.gb) ? ` · generic ballot ${pl.gb > 0 ? '<span class="d">D+' + pl.gb + '</span>' : pl.gb < 0 ? '<span class="r">R+' + (-pl.gb) + '</span>' : 'EVEN'}` : ''}${pl.updatedAt && typeof ago === 'function' ? ` <span class="muted">· updated ${ago(pl.updatedAt)} ago</span>` : ''}`;
  }
  function onMapCtlClick(e) {
    const b = e.target.closest('button'); if (!b) return;
    if (b.classList.contains('gm-fillall')) { const n = fillFromMarkets(); renderMapSummary(n ? `filled ${n} race${n === 1 ? '' : 's'} from markets` : 'every race already picked'); return; }
    if (b.classList.contains('gm-clear')) {
      if (!GM.entry || locked()) return;
      const n = Object.keys(GM.entry.picks).length; if (!n) return;
      if (!confirm(`Clear all ${n} Senate picks?`)) return;
      GM.entry.picks = {}; syncPickButtons(); updateMap(); renderMapSummary(); scheduleSave();
    }
  }
  function tileLabel(id, pick) {
    if (pick) return pick === 'D' ? 'DEM' : 'GOP';
    const v = mkt(id);
    if (isNum(v)) return v >= 50 ? `D ${Math.round(v)}` : `R ${Math.round(100 - v)}`;
    const f = favorite(id); return f ? f : '';
  }
  function updateMap() {
    if (!GM.container) return;
    const wrap = GM.container.querySelector('.gm-mapwrap');
    const ids = senateIds();
    if (!ids.length || typeof window.tileGridSVG !== 'function') { if (!wrap.querySelector('svg')) wrap.innerHTML = '<div class="muted gm-pad">waiting for race data…</div>'; return; }
    const picks = viewPicks(), det = viewDetail(), ed = editable();
    const SE = G.SEATS();
    const sig = `${GM.viewId}|${ed}|${JSON.stringify(picks)}|${JSON.stringify(det)}|${ids.join(',')}|${SE && SE.marketsUpdatedAt}`;
    if (sig === GM.mapSig) return;
    GM.mapSig = sig;
    const has = new Set(ids.map(id => id.slice(0, 2)));
    wrap.innerHTML = window.tileGridSVG({
      title: 'Senate pick map', size: 60, gap: 3,
      fill: s => { const v = has.has(s) ? picks[`${s}-Sen`] : null; return v === 'D' ? 'var(--dem)' : v === 'R' ? 'var(--rep)' : 'var(--none)'; },
      label: s => has.has(s) ? tileLabel(`${s}-Sen`, picks[`${s}-Sen`]) : '',
      cls: s => {
        if (!has.has(s)) return 'none';
        const id = `${s}-Sen`, v = picks[id], k = det[id];
        return 'has' + (v ? ' picked p' + v : ' unpicked') + (RES[k] ? ' rg-' + k : '');
      },
    });
    const svg = wrap.querySelector('svg');
    if (svg) {
      svg.classList.add('gm-tiles'); svg.classList.toggle('gm-edit', ed);
      for (const g of svg.querySelectorAll('g.tile.has')) { g.setAttribute('tabindex', '0'); g.setAttribute('role', 'button'); g.setAttribute('aria-label', `${g.dataset.st} Senate: ${picks[g.dataset.st + '-Sen'] || 'no pick'}`); }
    }
  }
  function renderList() {
    const root = GM.container.querySelector('.gm-picks');
    const rows = sortedSenate();
    if (!rows.length) { if (GM.listSig !== 'empty') { GM.listSig = 'empty'; root.innerHTML = ''; } return; }
    const ed = editable(), sig = rows.map(x => x.id + (x.r && x.r.rating)).join(',') + '|' + ed + '|' + (G.SEATS() && G.SEATS().marketsUpdatedAt) + '|' + (G.SEATS() && G.SEATS().updatedAt);
    if (sig !== GM.listSig) {
      GM.listSig = sig;
      const dis = ed ? '' : ' disabled';
      root.innerHTML = `<div class="gm-grp">SENATE RACES <span class="muted">· ${rows.length} · toss-ups first</span></div>` + rows.map(x => `<div class="gm-pk" data-id="${h(x.id)}">
        <div class="gm-pk-l"><a class="gm-rid" data-modal="${h(x.id)}">${h(x.id.slice(0, 2))}</a> <span class="gm-c">${cands(x.r)}</span><div class="gm-pk-m"><span class="muted">${h(ratingShort(x.r && x.r.rating))}</span> ${mktTag(x.id)} <span class="gm-res"></span></div></div>
        <div class="gm-tg"><button class="gm-d" data-v="D"${dis} aria-label="${h(x.id)} Democrat">D</button><button class="gm-r" data-v="R"${dis} aria-label="${h(x.id)} Republican">R</button></div></div>`).join('');
    }
    syncPickButtons();
  }
  function syncPickButtons(onlyId) {
    if (!GM.container) return;
    const root = GM.container.querySelector('.gm-picks'); if (!root) return;
    const picks = viewPicks(), det = viewDetail();
    const rows = onlyId ? root.querySelectorAll(`.gm-pk[data-id="${CSS.escape(onlyId)}"]`) : root.querySelectorAll('.gm-pk');
    for (const row of rows) {
      const v = picks[row.dataset.id];
      for (const b of row.querySelectorAll('.gm-tg button')) b.classList.toggle('on', b.dataset.v === v);
      const res = row.querySelector('.gm-res'), s = det[row.dataset.id];
      const html = s === 'correct' ? '<span class="over">✓ correct</span>' : s === 'wrong' ? '<span class="under">✗ wrong</span>' : s === 'leading-right' ? '<span class="over">leading ✓</span>' : s === 'leading-wrong' ? '<span class="under">trailing</span>' : '';
      if (res && res.innerHTML !== html) res.innerHTML = html;
    }
  }
  function onListClick(e) {
    const t = e.target;
    const a = t.closest('[data-modal]'); if (a) { if (window.openRaceModal) try { window.openRaceModal(a.dataset.modal); } catch (err) { report('modal: ' + err.message); } return; }
    const b = t.closest('.gm-tg button'); if (b && !b.disabled) { const id = b.closest('.gm-pk').dataset.id; setPick(id, GM.entry && GM.entry.picks[id] === b.dataset.v ? null : b.dataset.v); showInfo(id); }
  }
  function renderMapSummary(msg) {
    const el = GM.container && GM.container.querySelector('.gm-msum'); if (!el) return;
    const picks = viewPicks(), ed = editable(), ids = senateIds();
    const n = ids.length || 35, d = ids.filter(id => picks[id] === 'D').length, r = ids.filter(id => picks[id] === 'R').length;
    let txt = `<span class="d">D ${d}</span> · <span class="r">R ${r}</span> · ${Math.max(0, n - d - r)} unpicked`;
    if (!ed && !(ownView() && !GM.data)) {
      const det = viewDetail(); let c = 0, w = 0, lr = 0, lw = 0, p = 0;
      for (const id in picks) { const k = det[id]; if (k === 'correct') c++; else if (k === 'wrong') w++; else if (k === 'leading-right') lr++; else if (k === 'leading-wrong') lw++; else p++; }
      if (Object.keys(picks).length) txt += ` · <span class="over">correct ${c}</span> · <span class="under">wrong ${w}</span> · pending ${p + lr + lw}${lr || lw ? ` (leading right ${lr}, wrong ${lw})` : ''}`;
      txt += `<div class="gm-legend"><span><i class="lg-c"></i>correct</span><span><i class="lg-w"></i>wrong</span><span><i class="lg-l"></i>leading</span></div>`;
    }
    el.innerHTML = (msg ? `<span class="dim">${h(msg)}</span> · ` : '') + txt;
  }

  // ---- main
  function paint() {
    if (!GM.container || !GM.container.isConnected) return;
    try {
      if (GM.data && GM.lockedSeen !== GM.data.locked) { GM.lockedSeen = GM.data.locked; GM.entrySig = ''; GM.mapSig = ''; GM.listSig = ''; }
      if (GM.viewId && GM.data && !(GM.data.players || []).some(p => p.id === GM.viewId) && !(GM.me && GM.viewId === GM.me.id)) GM.viewId = GM.me ? GM.me.id : null;
      if (!GM.viewId && !GM.me && GM.data && (GM.data.players || [])[0]) GM.viewId = GM.data.players[0].id;
      renderBoard(); renderEntry(); renderSaveState(); renderMapChrome();
      updateMap(); renderList(); renderMapSummary();
      if (GM.info) showInfo(GM.info);
    } catch (e) { report('render: ' + e.message); }
  }
  function readMe() { const m = st.get('game:me'); return m && m.id && m.token ? m : null; }
  function renderGame(container) {
    try {
      if (!container) return;
      if (GM.container !== container || !container.querySelector('.gm-wrap')) {
        build(container);
        GM.me = readMe();
        if (GM.me && !GM.viewId) GM.viewId = GM.me.id;
      }
      if (GM.me && !GM.entry && !GM.entryLoading && !GM.entryErr) loadEntry();
      paint();
      fetchGame(false);
    } catch (e) { report('renderGame: ' + e.message); }
  }
  // Called by onboard.js after it registers / saves: re-read the stored identity and drop the cached entry.
  function reload() {
    clearTimeout(GM.saveTimer); GM.dirty = false;
    GM.me = readMe(); GM.entry = null; GM.entryErr = null; GM.joinErr = null; GM.editingName = false;
    GM.viewId = GM.me ? GM.me.id : null; GM.entrySig = ''; GM.mapSig = ''; GM.listSig = '';
    GM.save = { status: 'idle', t: 0, err: null };
    if (GM.container && GM.container.isConnected) { if (GM.me) loadEntry(); paint(); }
    fetchGame(true);
  }
  setInterval(() => { if (visible()) fetchGame(false); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (visible()) fetchGame(false); });
  window.renderGame = renderGame;
  // The host may try to open the game panel (e.g. ?view=game) before this script has loaded; render it now if so.
  try { const c = document.getElementById('game'); if (c && document.body.classList.contains('gameopen') && !c.querySelector('.gm-wrap')) renderGame(c); } catch (e) { report('initial render: ' + e.message); }
  window.Game = { reload, senateIds, favorite, raceById, fmtLockET, lockInstant, mkt, ratingShort, cands };
})();
