// First-visit onboarding wizard for the predictions game: one question per screen, saves after every step.
// Exposes window.openOnboarding(). Auto-opens for LAN/phone guests (never on localhost) or with ?join=1.
// Uses window.Game (game.js) and page globals S / SEATS when present; fetches /api/state and /api/seats itself otherwise.
(function () {
  'use strict';
  const KEY_ME = 'en26:game:me', KEY_DONE = 'en26:ob:done', KEY_SKIP = 'en26:ob:skipped';
  const NSTEPS = 6, SAVE_DEBOUNCE_MS = 500;
  const ls = {
    get(k) { try { const v = localStorage.getItem(k); return v === null ? null : JSON.parse(v); } catch (e) { return null; } },
    set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const h = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const isNum = v => typeof v === 'number' && isFinite(v);
  const report = msg => { try { if (typeof clientError === 'function') clientError('onboard', msg); else console.warn('onboard:', msg); } catch (e) {} };
  const pageS = () => { try { return typeof S !== 'undefined' && S ? S : null; } catch (e) { return null; } };
  const pageSEATS = () => { try { return typeof SEATS !== 'undefined' && SEATS ? SEATS : null; } catch (e) { return null; } };

  const OB = {
    el: null, open: false, step: 1, me: null, entry: null, game: null, ownS: null, ownSeats: null,
    joinErr: null, joined: false, editMe: false, busy: false,
    save: 'idle', saveTimer: null, saving: false, dirty: false, finished: false, lastFocus: null,
  };
  const st = () => pageS() || OB.ownS;
  const seats = () => pageSEATS() || OB.ownSeats;

  async function api(method, url, body) {
    const r = await fetch(url, method === 'GET' ? { cache: 'no-store' } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) { const e = new Error((j && j.error) || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return j;
  }
  function ensureData() {
    const jobs = [];
    if (!pageS() && !OB.ownS) jobs.push(api('GET', '/api/state').then(j => { OB.ownS = j; }).catch(e => report('/api/state: ' + e.message)));
    if (!pageSEATS() && !OB.ownSeats) jobs.push(api('GET', '/api/seats').then(j => { OB.ownSeats = j; }).catch(e => report('/api/seats: ' + e.message)));
    jobs.push(api('GET', '/api/game').then(j => { OB.game = j; }).catch(e => report('/api/game: ' + e.message)));
    return Promise.all(jobs);
  }

  // ---- race helpers (prefer game.js, which knows the page's market blend)
  function senateIds() {
    if (pageSEATS() && window.Game && window.Game.senateIds) return window.Game.senateIds();
    const SE = seats(); if (!SE) return [];
    const ids = []; for (const r of SE.senate || []) { const id = `${r.state}-Sen`; if (!ids.includes(id)) ids.push(id); }
    return ids.sort();
  }
  function mkt(id) {
    if (pageSEATS() && window.Game && window.Game.mkt) return window.Game.mkt(id);
    const SE = seats(), m = SE && SE.markets ? SE.markets[id] : null; if (!m) return null;
    const k = isNum(m.kD) ? m.kD : null, p = isNum(m.pD) ? m.pD : null;
    return k !== null && p !== null ? (k + p) / 2 : (k ?? p);
  }
  function favorite(id) {
    if (pageSEATS() && window.Game && window.Game.favorite) return window.Game.favorite(id);
    const v = mkt(id); if (isNum(v) && v !== 50) return v > 50 ? 'D' : 'R';
    const SE = seats(), r = SE && (SE.senate || []).find(x => `${x.state}-Sen` === id), rt = r && r.rating;
    if (rt && /dem$/.test(rt)) return 'D'; if (rt && /rep$/.test(rt)) return 'R';
    return null;
  }
  function controlPD(ch) {
    const s = st(); if (!s) return null;
    const k = s.kalshi && s.kalshi.control && s.kalshi.control[ch], p = s.polymarket && s.polymarket.control && s.polymarket.control[ch];
    const a = k && isNum(k.pD) ? k.pD : null, b = p && isNum(p.pD) ? p.pD : null;
    return a !== null && b !== null ? (a + b) / 2 : (a ?? b);
  }
  const mktHint = (ch, label) => {
    const v = controlPD(ch); if (!isNum(v)) return '';
    return v >= 50 ? `Markets: <span class="d">Dems ${Math.round(v)}%</span> to win the ${label}` : `Markets: <span class="r">GOP ${Math.round(100 - v)}%</span> to win the ${label}`;
  };
  const pollGB = () => { const s = st(), m = s && s.polls && s.polls.genericBallot && s.polls.genericBallot.margin; return isNum(m) ? m : null; };
  const fmtGB = v => !isNum(v) ? '—' : Math.abs(v) < 0.05 ? 'EVEN' : v > 0 ? `D+${v.toFixed(1)}` : `R+${(-v).toFixed(1)}`;
  const fmtLock = () => { const l = OB.game && OB.game.lockET; return window.Game && window.Game.fmtLockET ? window.Game.fmtLockET(l) : '7:00 PM ET'; };
  const homeTxt = hm => hm ? `${hm.city}, ${hm.state}${hm.district ? ` (${hm.district})` : ''}` : '';

  // ---- saving
  function entryBody(extra) {
    const e = OB.entry || {};
    const picks = {}; for (const k in e.picks || {}) if (/-Sen$/.test(k)) picks[k] = e.picks[k];
    return Object.assign({ id: OB.me.id, token: OB.me.token, houseD: e.houseD, senateD: e.senateD, gb: e.gb, picks }, extra || {});
  }
  function scheduleSave() {
    if (!OB.me || !OB.entry || (OB.game && OB.game.locked)) return;
    OB.dirty = true; setSave('saving');
    clearTimeout(OB.saveTimer); OB.saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }
  async function saveNow(extra) {
    clearTimeout(OB.saveTimer);
    if (!OB.me || !OB.entry || (OB.game && OB.game.locked)) return null;
    if (OB.saving) { OB.dirty = true; return null; }
    OB.saving = true; OB.dirty = false; setSave('saving');
    let j = null;
    try { j = await api('POST', '/api/game/entry', entryBody(extra)); setSave('saved'); }
    catch (e) {
      setSave('error', e.message);
      if (e.status === 423) { OB.game = Object.assign({}, OB.game, { locked: true }); }
      if (extra) { OB.saving = false; throw e; }
    }
    OB.saving = false;
    if (OB.dirty) saveNow();
    return j;
  }
  function setSave(s, msg) {
    OB.save = s;
    const el = OB.el && OB.el.querySelector('.ob-save'); if (!el) return;
    el.className = 'ob-save ' + (s === 'error' ? 'is-err' : s === 'saved' ? 'is-ok' : '');
    el.textContent = s === 'saving' ? 'saving…' : s === 'saved' ? 'saved' : s === 'error' ? 'not saved' + (msg ? ': ' + msg : '') : '';
  }

  // ---- shell
  function build() {
    if (OB.el) return;
    const el = document.createElement('div');
    el.id = 'ob'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Join the predictions game');
    el.innerHTML = `<div class="ob-card">
      <div class="ob-top"><div class="ob-dots" aria-hidden="true"></div><span class="ob-save"></span><button class="ob-x" aria-label="Close" title="Close (Esc)">×</button></div>
      <div class="ob-body"></div>
      <div class="ob-foot"></div></div>`;
    document.body.appendChild(el);
    OB.el = el;
    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('keydown', onKey);
  }
  function openOnboarding() {
    try {
      build();
      OB.lastFocus = document.activeElement;
      OB.me = ls.get(KEY_ME); if (!(OB.me && OB.me.id && OB.me.token)) OB.me = null;
      OB.entry = null; OB.joinErr = null; OB.joined = false; OB.editMe = false; OB.finished = false; OB.busy = true;
      OB.step = OB.me ? 2 : 1;
      OB.open = true; OB.el.classList.add('on'); document.documentElement.classList.add('ob-open');
      render();
      ensureData().then(() => (OB.me ? loadMe() : null)).finally(() => { OB.busy = false; if (OB.open) render(true); });
    } catch (e) { report('open: ' + e.message); }
  }
  async function loadMe() {
    try {
      const j = await api('GET', `/api/game/me?id=${encodeURIComponent(OB.me.id)}&token=${encodeURIComponent(OB.me.token)}`);
      OB.entry = { houseD: j.houseD ?? null, senateD: j.senateD ?? null, gb: j.gb ?? null, picks: Object.assign({}, j.picks || {}) };
      if (j.name) OB.me.name = j.name; if (j.home) OB.me.home = j.home; ls.set(KEY_ME, OB.me);
      setSave(j.updatedAt ? 'saved' : 'idle');
    } catch (e) {
      if (e.status === 403) { ls.set(KEY_ME, null); OB.me = null; OB.step = 1; OB.joinErr = 'Your saved entry was not found on the server. Join again.'; }
      else { report('/api/game/me: ' + e.message); OB.entry = { houseD: null, senateD: null, gb: null, picks: {} }; }
    }
  }
  function close(finished) {
    if (!OB.open) return;
    clearTimeout(OB.saveTimer); if (OB.dirty && OB.me) saveNow();
    OB.open = false; OB.el.classList.remove('on'); document.documentElement.classList.remove('ob-open');
    if (finished) ls.set(KEY_DONE, 1); else if (!ls.get(KEY_DONE)) ls.set(KEY_SKIP, 1);
    try { if (window.Game && window.Game.reload) window.Game.reload(); } catch (e) { report('reload: ' + e.message); }
    try { if (OB.lastFocus && OB.lastFocus.focus) OB.lastFocus.focus(); } catch (e) {}
  }

  // ---- steps
  function dots() {
    let s = ''; for (let i = 1; i <= NSTEPS; i++) s += `<i class="${i === OB.step ? 'on' : i < OB.step ? 'done' : ''}"></i>`;
    return s + `<span class="ob-stepn">${OB.step}/${NSTEPS}</span>`;
  }
  const lockedOut = () => !!(OB.game && OB.game.locked);
  function slider(k, min, max, step, val, ticks) {
    const pct = v => ((v - min) / (max - min) * 100).toFixed(2);
    return `<div class="ob-slider"><input type="range" class="ob-range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${val}" aria-label="${k}" style="--p:${pct(val)}%"${lockedOut() ? ' disabled' : ''}>
      <div class="ob-ticks">${(ticks || []).map(t => `<span class="ob-tick" style="left:${pct(t.v)}%"><b></b>${h(t.label)}</span>`).join('')}</div>
      <div class="ob-ends"><span>${k === 'gb' ? 'R+10' : min}</span><span>${k === 'gb' ? 'D+10' : max}</span></div></div>
      <div class="ob-steppers"><button class="ob-nudge" data-k="${k}" data-d="-${step}" aria-label="less">−</button><button class="ob-nudge" data-k="${k}" data-d="${step}" aria-label="more">+</button></div>`;
  }
  function stepHTML() {
    const e = OB.entry;
    if (OB.busy && OB.step > 1 && !e) return { body: '<div class="ob-wait">loading your entry…</div>', foot: '' };
    if (lockedOut() && !OB.me) {
      return { body: `<div class="ob-kicker">Election Night 2026</div><h2>Entries locked at ${h(fmtLock())}.</h2><p class="ob-lede">Follow the leaderboard as the results come in.</p>`,
        foot: `<span></span><button class="ob-next" data-act="explore">Explore the dashboard</button>` };
    }
    switch (OB.step) {
      case 1: {
        if (OB.joined && OB.me) {
          return { body: `<div class="ob-kicker">Election Night 2026</div><h2>Hi ${h(OB.me.name)}${OB.me.home ? ` from ${h(homeTxt(OB.me.home))}` : ''}.</h2><p class="ob-lede">You're in. Three quick predictions and an optional Senate map. Everything saves as you go.</p>`,
            foot: `<span></span><button class="ob-next" data-act="next">Let's go</button>` };
        }
        const edit = !!OB.me;
        const z = OB.me && OB.me.home && OB.me.home.zip;
        return { body: `<div class="ob-kicker">Election Night 2026</div><h2>${edit ? 'Your name and hometown' : 'Make your predictions, then watch the leaderboard all night.'}</h2>
          ${edit ? '' : '<p class="ob-lede">Predict the House, the Senate and the national vote. Scores update live as races are called.</p>'}
          <label class="ob-field"><span>Your name</span><input class="ob-name" type="text" maxlength="24" autocomplete="nickname" autocapitalize="words" enterkeyhint="next" value="${h(OB.me ? OB.me.name : (OB.draftName || ''))}" placeholder="e.g. Pat"></label>
          <label class="ob-field"><span>Hometown zip code</span><input class="ob-zip" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" autocomplete="postal-code" enterkeyhint="go" value="${h(z || OB.draftZip || '')}" placeholder="5 digits"></label>
          <p class="ob-note">Where you're from, not where you live now. It puts your home House district on the Hometowns list.</p>
          <div class="ob-err" role="alert">${OB.joinErr ? h(OB.joinErr) : ''}</div>`,
          foot: edit ? `<button class="ob-back" data-act="next">Cancel</button><button class="ob-next" data-act="saveme">Save</button>` : `<span></span><button class="ob-next" data-act="join">Join</button>` };
      }
      case 2: {
        const pg = pollGB();
        if (!isNum(e.gb)) OB.defGB = isNum(pg) ? Math.max(-10, Math.min(10, Math.round(pg * 2) / 2)) : 0;
        const v = isNum(e.gb) ? Math.max(-10, Math.min(10, e.gb)) : OB.defGB;
        return { body: `<div class="ob-kicker">Generic ballot</div><h2>Who wins the national House vote, and by how much?</h2>
          <div class="ob-read ob-gb ${v > 0 ? 'd' : v < 0 ? 'r' : ''}" data-read="gb">${fmtGB(v)}</div>
          ${slider('gb', -10, 10, 0.5, v, [{ v: 0, label: 'even' }].concat(isNum(pg) && Math.abs(pg) <= 10 && Math.abs(pg) > 1.5 ? [{ v: pg, label: 'polls' }] : []))}
          <p class="ob-hint">${isNum(pg) ? `Polls say <b>${fmtGB(pg)}</b>` : 'Left = Republicans, right = Democrats'}</p>`, foot: navFoot() };
      }
      case 3: {
        const v = isNum(e.houseD) ? Math.max(170, Math.min(270, e.houseD)) : 220;
        return { body: `<div class="ob-kicker">House</div><h2>How many of the 435 House seats do Democrats win?</h2>
          <div class="ob-read" data-read="houseD">${seatRead(v, 435)}</div>
          ${slider('houseD', 170, 270, 1, v, [{ v: 218, label: '218 = majority' }])}
          <p class="ob-hint">${mktHint('house', 'House') || '218 seats wins the majority'}</p>`, foot: navFoot() };
      }
      case 4: {
        const v = isNum(e.senateD) ? Math.max(40, Math.min(60, e.senateD)) : 50;
        return { body: `<div class="ob-kicker">Senate</div><h2>How many of the 100 Senate seats do Democrats hold after tonight?</h2>
          <div class="ob-read" data-read="senateD">${seatRead(v, 100)}</div>
          ${slider('senateD', 40, 60, 1, v, [{ v: 50, label: '50 + VP' }])}
          <p class="ob-hint">${mktHint('senate', 'Senate') || '50 seats plus the Vice President is control'}</p>`, foot: navFoot() };
      }
      case 5: {
        const ids = senateIds();
        return { body: `<div class="ob-kicker">Senate map · optional</div><h2>Pick the Senate winners</h2>
          <p class="ob-note">Tap a state: <span class="d">D</span> → <span class="r">R</span> → none. Unpicked states show the market favorite.</p>
          <div class="ob-map">${ids.length ? mapSVG() : '<div class="ob-wait">loading races…</div>'}</div>
          <div class="ob-count">${countTxt()}</div>
          <div class="ob-mapbtns"><button class="ob-btn" data-act="fill"${lockedOut() ? ' disabled' : ''}>Fill from markets</button><button class="ob-btn" data-act="clearpicks"${lockedOut() ? ' disabled' : ''}>Clear</button></div>`,
          foot: `<button class="ob-back" data-act="back">Back</button><span class="ob-sp"></span><button class="ob-skip" data-act="next">Skip</button><button class="ob-next" data-act="next">Next</button>` };
      }
      case 6: {
        const n = Object.keys(e.picks || {}).filter(k => /-Sen$/.test(k)).length;
        const row = (k, v) => `<div class="ob-sumrow"><span>${k}</span><b>${v}</b></div>`;
        return { body: `<div class="ob-kicker">${lockedOut() ? 'Entries locked' : 'All set'}</div><h2>${lockedOut() ? 'Your entry is final.' : 'You’re on the board.'}</h2>
          <div class="ob-sum">
            ${row('Name', h(OB.me ? OB.me.name : ''))}
            ${row('Hometown', h(homeTxt(OB.me && OB.me.home)) || '—')}
            ${row('Generic ballot', `<span class="${e.gb > 0 ? 'd' : e.gb < 0 ? 'r' : ''}">${fmtGB(e.gb)}</span>`)}
            ${row('House', isNum(e.houseD) ? `<span class="d">D ${e.houseD}</span> · <span class="r">R ${435 - e.houseD}</span>` : '—')}
            ${row('Senate', isNum(e.senateD) ? `<span class="d">D ${e.senateD}</span> · <span class="r">R ${100 - e.senateD}</span>` : '—')}
            ${row('Senate picks', `${n} of ${senateIds().length || 35}`)}
          </div>
          ${lockedOut() ? '' : `<p class="ob-note">You can change anything until ${h(fmtLock())}. <button class="ob-link" data-act="editme">Edit name / zip</button></p>`}`,
          foot: `<button class="ob-link ob-explore" data-act="explore">Explore the dashboard</button><button class="ob-next" data-act="finish">See the leaderboard</button>` };
      }
    }
    return { body: '', foot: '' };
  }
  const seatRead = (d, tot) => `<span class="d">D ${d}</span><span class="ob-dot">·</span><span class="r">R ${tot - d}</span>`;
  const navFoot = () => `<button class="ob-back" data-act="back">Back</button><span class="ob-sp"></span><button class="ob-next" data-act="next">Next</button>`;
  function mapSVG() {
    if (typeof window.tileGridSVG !== 'function') return '';
    const ids = senateIds(), has = new Set(ids.map(id => id.slice(0, 2))), picks = (OB.entry && OB.entry.picks) || {};
    const svg = window.tileGridSVG({
      title: 'Senate picks', size: 60, gap: 3,
      fill: s => { const v = has.has(s) && picks[`${s}-Sen`]; return v === 'D' ? 'var(--dem)' : v === 'R' ? 'var(--rep)' : 'var(--none)'; },
      label: s => {
        if (!has.has(s)) return '';
        const v = picks[`${s}-Sen`]; if (v) return v === 'D' ? 'DEM' : 'GOP';
        const m = mkt(`${s}-Sen`); if (isNum(m)) return m >= 50 ? `D ${Math.round(m)}` : `R ${Math.round(100 - m)}`;
        return favorite(`${s}-Sen`) || '';
      },
      cls: s => !has.has(s) ? 'none' : 'has ' + (picks[`${s}-Sen`] ? 'picked' : 'unpicked'),
    });
    return svg.replace('<svg class="tiles"', '<svg class="tiles ob-tiles"');
  }
  function countTxt() {
    const ids = senateIds(), p = (OB.entry && OB.entry.picks) || {};
    const d = ids.filter(id => p[id] === 'D').length, r = ids.filter(id => p[id] === 'R').length;
    return `<span class="d">D ${d}</span> · <span class="r">R ${r}</span> · ${Math.max(0, ids.length - d - r)} unpicked`;
  }
  function render(keepFocus) {
    if (!OB.el) return;
    if (OB.step > 1 && OB.me && !OB.entry && !OB.busy) OB.entry = { houseD: null, senateD: null, gb: null, picks: {} };
    const { body, foot } = stepHTML();
    OB.el.querySelector('.ob-dots').innerHTML = dots();
    const b = OB.el.querySelector('.ob-body');
    const focusedSel = keepFocus && document.activeElement && b.contains(document.activeElement) ? (document.activeElement.className || '').split(' ')[0] : null;
    b.innerHTML = body; b.scrollTop = 0;
    OB.el.querySelector('.ob-foot').innerHTML = foot;
    setSave(OB.save);
    if (focusedSel) { const f = b.querySelector('.' + focusedSel); if (f) f.focus(); return; }
    const first = b.querySelector('input:not([type=range]), .ob-range') || OB.el.querySelector('.ob-next');
    const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    // on phones, do not pop the keyboard over the welcome text automatically
    if (first && !(touch && first.tagName === 'INPUT' && first.type === 'text')) try { first.focus({ preventScroll: true }); } catch (e) {}
  }
  function go(step) {
    // commit the visible default of a slider step when moving forward from it
    commitDefault();
    OB.step = Math.max(1, Math.min(NSTEPS, step));
    if (OB.step === 1 && OB.me) OB.joined = false;
    render();
  }
  function commitDefault() {
    if (!OB.entry || lockedOut()) return false;
    const r = OB.el.querySelector('.ob-range'); if (!r) return false;
    const k = r.dataset.k, v = parseFloat(r.value);
    if (OB.entry[k] !== v) { OB.entry[k] = v; return true; }
    return false;
  }

  // ---- events
  async function onClick(ev) {
    const t = ev.target;
    if (t === OB.el) return;   // backdrop tap does nothing (too easy to lose progress)
    if (t.closest('.ob-x')) { close(false); return; }
    const g = t.closest && t.closest('g.tile.has');
    if (g && OB.step === 5) { if (lockedOut() || !OB.entry) return; const id = `${g.dataset.st}-Sen`, c = OB.entry.picks[id]; if (!c) OB.entry.picks[id] = 'D'; else if (c === 'D') OB.entry.picks[id] = 'R'; else delete OB.entry.picks[id]; refreshMap(); scheduleSave(); return; }
    const n = t.closest('.ob-nudge');
    if (n) { const r = OB.el.querySelector(`.ob-range[data-k="${n.dataset.k}"]`); if (r && !r.disabled) { r.value = String(Math.max(+r.min, Math.min(+r.max, parseFloat(r.value) + parseFloat(n.dataset.d)))); onRange(r); scheduleSave(); } return; }
    const b = t.closest('[data-act]'); if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'join') return doJoin();
    if (act === 'saveme') return doSaveMe();
    if (act === 'editme') { OB.step = 1; OB.joined = false; OB.joinErr = null; OB.editMe = true; render(); return; }
    if (act === 'back') { go(OB.step - 1); return; }
    if (act === 'next') {
      if (OB.step === 1 && OB.editMe) { OB.editMe = false; OB.step = 6; render(); return; }
      const changed = commitDefault();
      if (OB.me && OB.entry && !lockedOut() && (changed || OB.dirty || OB.step >= 2)) saveNow();
      go(OB.step + 1); return;
    }
    if (act === 'fill') { let k = 0; for (const id of senateIds()) { if (OB.entry.picks[id]) continue; const f = favorite(id); if (f) { OB.entry.picks[id] = f; k++; } } refreshMap(); scheduleSave(); return; }
    if (act === 'clearpicks') { if (!Object.keys(OB.entry.picks).length) return; OB.entry.picks = {}; refreshMap(); scheduleSave(); return; }
    if (act === 'explore') { close(true); return; }
    if (act === 'finish') {
      if (OB.dirty) saveNow();
      close(true);
      try { if (window.showGame) window.showGame(true); } catch (e) { report('showGame: ' + e.message); }
    }
  }
  function refreshMap() {
    const m = OB.el.querySelector('.ob-map'), c = OB.el.querySelector('.ob-count');
    if (m) m.innerHTML = mapSVG(); if (c) c.innerHTML = countTxt();
  }
  function onRange(r) {
    const k = r.dataset.k, v = parseFloat(r.value);
    r.style.setProperty('--p', ((v - r.min) / (r.max - r.min) * 100).toFixed(2) + '%');
    if (OB.entry) OB.entry[k] = v;
    const out = OB.el.querySelector(`[data-read="${k}"]`); if (!out) return;
    if (k === 'gb') { out.textContent = fmtGB(v); out.className = 'ob-read ob-gb ' + (v > 0 ? 'd' : v < 0 ? 'r' : ''); }
    else out.innerHTML = seatRead(v, k === 'houseD' ? 435 : 100);
  }
  function onInput(ev) {
    const t = ev.target;
    if (t.classList.contains('ob-range')) { onRange(t); scheduleSave(); return; }
    if (t.classList.contains('ob-zip')) { const v = t.value.replace(/\D/g, '').slice(0, 5); if (v !== t.value) t.value = v; OB.draftZip = v; }
    if (t.classList.contains('ob-name')) OB.draftName = t.value;
  }
  function onChange(ev) { if (ev.target.classList.contains('ob-range')) saveNow(); }
  function onKey(ev) {
    ev.stopPropagation();   // modal: keep the dashboard's single-key shortcuts (g, t, f…) from firing underneath
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(false); return; }
    if (ev.key === 'Enter' && ev.target.classList) {
      if (ev.target.classList.contains('ob-name')) { ev.preventDefault(); const z = OB.el.querySelector('.ob-zip'); if (z) z.focus(); return; }
      if (ev.target.classList.contains('ob-zip')) { ev.preventDefault(); if (OB.me) doSaveMe(); else doJoin(); return; }
    }
    if (ev.key === 'Tab') {   // keep focus inside the dialog
      const f = [...OB.el.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex="0"]')].filter(x => x.offsetParent !== null);
      if (!f.length) return;
      if (ev.shiftKey && document.activeElement === f[0]) { ev.preventDefault(); f[f.length - 1].focus(); }
      else if (!ev.shiftKey && document.activeElement === f[f.length - 1]) { ev.preventDefault(); f[0].focus(); }
    }
  }
  function readMeForm() {
    const name = (OB.el.querySelector('.ob-name') || {}).value || '', zip = ((OB.el.querySelector('.ob-zip') || {}).value || '').trim();
    return { name: name.trim(), zip };
  }
  function showErr(msg) { OB.joinErr = msg; const e = OB.el.querySelector('.ob-err'); if (e) e.textContent = msg || ''; }
  function setBusy(on, label) { const b = OB.el.querySelector('.ob-next'); if (b) { b.disabled = on; if (label) b.textContent = label; } }
  // New York City zips (Manhattan 100–102, Staten Island 103, Bronx 104, Queens 110–111 and 113–116, Brooklyn 112)
  const isNYC = z => /^(10[0-4]|11[0-6])\d{2}$/.test(z);
  function nycWarned(zip) {
    if (!isNYC(zip) || OB.nycOk === zip) return false;
    OB.nycOk = zip;
    showErr("That's a New York City zip. Use the zip of your hometown, where you grew up, not where you live now. If NYC really is home, press the button again.");
    setBusy(false, OB.me ? 'Use it anyway' : 'Join anyway');
    return true;
  }
  async function doJoin() {
    const { name, zip } = readMeForm();
    if (!name) { showErr('Enter your name.'); (OB.el.querySelector('.ob-name') || {}).focus?.(); return; }
    if (!/^\d{5}$/.test(zip)) { showErr('Enter your 5-digit hometown zip code.'); (OB.el.querySelector('.ob-zip') || {}).focus?.(); return; }
    if (nycWarned(zip)) return;
    showErr(''); setBusy(true, 'Joining…');
    try {
      const j = await api('POST', '/api/game/register', { name, zip });
      OB.me = { id: j.id, token: j.token, name: j.name, home: j.home || null }; ls.set(KEY_ME, OB.me);
      OB.entry = { houseD: null, senateD: null, gb: null, picks: {} }; OB.joined = true; OB.joinErr = null; OB.draftName = OB.draftZip = '';
      try { if (window.Game && window.Game.reload) window.Game.reload(); } catch (e) {}
      render();
    } catch (e) {
      setBusy(false, 'Join');
      if (e.status === 409) showErr(`“${name}” is taken. Try ${suggest(name)}?`);
      else if (e.status === 423) { OB.game = Object.assign({}, OB.game, { locked: true }); render(); }
      else if (e.status === 400 && /zip/i.test(e.message)) { showErr('That zip code was not recognized. Check the 5 digits.'); (OB.el.querySelector('.ob-zip') || {}).focus?.(); }
      else showErr(e.status ? e.message : 'Could not reach the server. Check the Wi-Fi and try again.');
    }
  }
  function suggest(name) {
    const taken = new Set(((OB.game && OB.game.players) || []).map(p => p.name.toLowerCase())), base = name.slice(0, 20);
    const home = OB.me && OB.me.home, city = home ? home.city.split(' ')[0] : '';
    const cands = [city ? `${base.split(' ')[0]} from ${city}` : '', `${base} 2`, `${base} ${Math.floor(Math.random() * 90 + 10)}`].filter(Boolean);
    const c = cands.find(x => x.length <= 24 && !taken.has(x.toLowerCase())) || cands[2];
    return `“${c.slice(0, 24)}”`;
  }
  async function doSaveMe() {
    const { name, zip } = readMeForm();
    if (!name) { showErr('Enter your name.'); return; }
    if (zip && !/^\d{5}$/.test(zip)) { showErr('Enter your 5-digit hometown zip code.'); return; }
    if (zip && zip !== ((OB.me.home && OB.me.home.zip) || '') && nycWarned(zip)) return;
    const extra = {};
    if (name !== OB.me.name) extra.name = name;
    if (zip && zip !== ((OB.me.home && OB.me.home.zip) || '')) extra.zip = zip;
    if (!Object.keys(extra).length) { OB.step = OB.editMe ? 6 : 2; OB.editMe = false; render(); return; }
    showErr(''); setBusy(true, 'Saving…');
    try {
      const j = await saveNow(extra);
      const p = j && j.player;
      if (p) { OB.me.name = p.name; if (p.home) OB.me.home = p.home; ls.set(KEY_ME, OB.me); }
      if (extra.name && p && p.name !== extra.name) { setBusy(false, 'Save'); showErr(`“${extra.name}” is taken; you're still ${p.name}. Try ${suggest(extra.name)}?`); return; }
      try { if (window.Game && window.Game.reload) window.Game.reload(); } catch (e) {}
      const back = OB.editMe ? 6 : 2; OB.editMe = false; OB.step = back; render();
    } catch (e) {
      setBusy(false, 'Save');
      if (e.status === 400 && /zip/i.test(e.message)) showErr('That zip code was not recognized. Check the 5 digits.');
      else showErr(e.message);
    }
  }

  // ---- auto-open
  function shouldAutoOpen() {
    try {
      const q = new URLSearchParams(location.search);
      if (q.get('join') === '1') return true;
      const host = location.hostname;
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host === '') return false;
      return !ls.get(KEY_ME) && !ls.get(KEY_SKIP);
    } catch (e) { return false; }
  }
  window.openOnboarding = openOnboarding;
  const kick = () => setTimeout(() => { if (!OB.open && shouldAutoOpen()) openOnboarding(); }, 700);
  if (document.readyState === 'complete') kick(); else window.addEventListener('load', kick, { once: true });
})();
