// 50-state tile grid (the NPR / FiveThirtyEight layout): one square per state, roughly where it sits on the map.
// window.TILE_GRID: { ST: [col, row] }.  window.tileGridSVG(opts) returns an <svg> string.
//   opts.fill(st) -> css color, opts.label(st) -> small text under the abbreviation (optional), opts.cls(st) -> extra class,
//   opts.states -> array of state codes to draw (default all 50), opts.size -> tile size (default 60), opts.gap (default 4)
(function () {
  'use strict';
  const rows = [
    'AK . . . . . . . . . ME',
    '. . . . . . . . . VT NH',
    'WA ID MT ND MN IL WI MI NY RI MA',
    'OR NV WY SD IA IN OH PA NJ CT .',
    'CA UT CO NE MO KY WV VA MD DE .',
    '. AZ NM KS AR TN NC SC . . .',
    '. . . OK LA MS AL GA . . .',
    'HI . . TX . . . . FL . .',
  ];
  const GRID = {};
  rows.forEach((r, y) => r.split(' ').forEach((st, x) => { if (st !== '.') GRID[st] = [x, y]; }));
  window.TILE_GRID = GRID;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  window.tileGridSVG = function (o) {
    o = o || {};
    const size = o.size || 60, gap = o.gap == null ? 4 : o.gap, step = size + gap, pad = 2;
    const states = o.states || Object.keys(GRID);
    const cols = 11, nrows = rows.length;
    const W = cols * step - gap + pad * 2, H = nrows * step - gap + pad * 2;
    let s = `<svg class="tiles" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(o.title || 'state tile map')}"><g class="zl">`;
    for (const st of states) {
      const g = GRID[st]; if (!g) continue;
      const x = pad + g[0] * step, y = pad + g[1] * step;
      const fill = o.fill ? o.fill(st) : 'var(--none)', cls = o.cls ? o.cls(st) : '', lab = o.label ? o.label(st) : '';
      s += `<g class="tile ${cls}" data-st="${st}" transform="translate(${x},${y})"><rect width="${size}" height="${size}" rx="3" fill="${fill}"></rect>` +
        `<text x="${size / 2}" y="${lab ? size * 0.42 : size * 0.55}" text-anchor="middle" dominant-baseline="middle" font-size="${Math.round(size * 0.3)}" font-weight="500">${st}</text>` +
        (lab ? `<text class="sub" x="${size / 2}" y="${size * 0.74}" text-anchor="middle" dominant-baseline="middle" font-size="${Math.round(size * 0.19)}">${esc(lab)}</text>` : '') + '</g>';
    }
    return s + '</g></svg>';
  };
})();
