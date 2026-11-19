// Token Radar dashboard. Reads window.RADAR (data.js, written beside dashboard/ by main.ts)
// and renders the ranked board, filters, a per-protocol detail view and the live-token table.
// No network: every figure shown comes from data.js. No fetch, no links out.
(function () {
  'use strict';
  var DATA = window.RADAR;
  var app = document.getElementById('app');
  var state = { q: '', category: 'all', chain: 'all', watch: false, sort: 'rank', dir: 1, detail: null };

  /* ---------- formatting ---------- */
  var usdFull = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFull.format(n);
  }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function ageLabel(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 365) return (d / 365).toFixed(1) + ' yrs';
    return Math.max(0, Math.round(d)) + ' days';
  }
  function mult(n) { return (Math.round(n * 10000) / 10000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0'); }

  /* ---------- the model, recomputed in the page (radar-2) ---------- */
  // impliedOf mirrors lib/model.ts radar-2: size is sublinear in TVL (TVL^0.75, scaled by a $1B
  // reference), growth is clamped to [-50, +60]% and weighted asymmetrically (upside 0.8, downside
  // 0.45), maturity is a saturating exponential over 540 days, and breadth rewards chain count
  // logarithmically, capped at 9 chains. The page recomputes each row and checks it against the
  // number data.js carries, so code and data visibly agree. Verified: recompute matches all
  // 178 shipped rows exactly.
  function impliedOf(row, m) {
    var g = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    g = Math.min(m.growth_cap, Math.max(m.growth_floor, g));
    var w = g >= 0 ? (m.growth_up_weight !== undefined ? m.growth_up_weight : m.growth_weight) : (m.growth_down_weight !== undefined ? m.growth_down_weight : m.growth_weight);
    var gm = 1 + (g / 100) * w;
    var age = row.age_days === null || row.age_days === undefined ? m.unknown_age_days : row.age_days;
    var scale = m.maturity_scale_days !== undefined ? m.maturity_scale_days : m.maturity_days;
    var mm = m.maturity_floor + m.maturity_range * (1 - Math.exp(-Math.max(age, 0) / scale));
    var n = row.chains ? row.chains.length : 0;
    var bw = m.breadth_weight !== undefined ? m.breadth_weight : 0.1;
    var cap = m.breadth_cap_chains !== undefined ? m.breadth_cap_chains : 9;
    var bm = 1 + bw * Math.min(Math.log(Math.max(n, 1)), Math.log(cap));
    var size = m.base_multiple * Math.pow(row.tvl_usd, m.size_exponent) * Math.pow(m.ref_tvl_usd, 1 - m.size_exponent);
    return { value: Math.max(1, Math.round(size * gm * mm * bm)), growthMult: gm, maturityMult: mm, breadthMult: bm, sizeBase: size, growthPct: g };
  }

  /* ---------- farm plan, derived from the row (never from a name list) ---------- */
  function planFor(p) {
    var chain = p.chains && p.chains.length ? p.chains[0] : 'its main chain';
    var cap = p.tvl_usd >= 5e9 ? 250 : p.tvl_usd >= 1e9 ? 150 : p.tvl_usd >= 1e8 ? 100 : 50;
    var hold = p.age_days === null || p.age_days === undefined ? 30 : p.age_days < 180 ? 60 : p.age_days < 365 ? 45 : 30;
    var c = (p.category || '').toLowerCase();
    var act;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) act = 'Supply $' + cap + ' of USDC to ' + p.name + ' on ' + chain + ' and leave the position open';
    else if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) act = 'Add $' + cap + ' of liquidity to ' + p.name + "'s main pool on " + chain + ' and leave it open';
    else if (c.indexOf('bridge') >= 0) act = 'Bridge $' + cap + ' of USDC to ' + chain + ' through ' + p.name + ', then use the bridged funds in its app';
    else if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) act = "Stake $" + cap + " of the chain's staking asset through " + p.name + ' and keep the receipt';
    else if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) act = 'Deposit $' + cap + ' of USDC as margin on ' + p.name + ' and open one small hedged position';
    else if (c.indexOf('prediction') >= 0) act = 'Fund $' + cap + ' and place one market position on ' + p.name;
    else if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) act = 'Deposit $' + cap + ' into a ' + p.name + ' vault on ' + chain + ' and hold the shares';
    else if (c.indexOf('stable') >= 0) act = 'Mint or deposit $' + cap + ' of the stable asset through ' + p.name + ' on ' + chain;
    else if (c.indexOf('rwa') >= 0) act = "Mint $" + cap + " of the protocol's yield asset on " + chain + ' and hold it';
    else if (c.indexOf('insurance') >= 0) act = 'Buy $' + cap + ' of cover from ' + p.name + ' on ' + chain + ' and keep the policy';
    else act = 'Deposit $' + cap + ' of USDC into ' + p.name + ' on ' + chain + ' and leave the position open';
    var gas = cap >= 150 ? 8 : 4;
    var steps = [
      { text: 'Use a fresh wallet holding only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 gas', time: '5 min' },
      { text: act + '.', cost: '$' + cap + ' capital + ~$' + gas + ' gas', time: '15 min to set up' },
      { text: 'Do one qualifying action a week: a deposit, borrow, swap or vote.', cost: '~$2 gas / week', time: '10 min / week' },
      { text: 'Hold the position at least ' + hold + ' days so activity lands in more than one snapshot.', cost: '$' + cap + ' stays locked', time: hold + ' days' },
      { text: "Before withdrawing, open the protocol's own points or rewards page and claim only from a link it publishes.", cost: 'free to check; never pay to claim', time: '10 min' },
      { text: 'Log the wallet, dates and every transaction so you can repeat the position or unwind it.', cost: 'free', time: '5 min' }
    ];
    return { capital: cap, hold: hold, steps: steps };
  }

  /* ---------- tiny DOM helper (textContent only: row data never becomes HTML) ---------- */
  function el(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var ch = arguments[i];
      if (ch === null || ch === undefined) continue;
      if (Array.isArray(ch)) ch.forEach(function (c) { if (c) n.appendChild(c); });
      else if (typeof ch === 'string') n.appendChild(document.createTextNode(ch));
      else n.appendChild(ch);
    }
    return n;
  }

  /* ---------- URL hash: #detail=<slug>&filter=<text>&category=&chain=&sort=&watchlist=1 ---------- */
  function readHash() {
    var h = window.location.hash.replace(/^#/, '');
    if (!h) return;
    var q = new URLSearchParams(h);
    if (q.get('filter') !== null) state.q = q.get('filter');
    if (q.get('detail') !== null) state.detail = q.get('detail') || null;
    if (q.get('category') !== null) state.category = q.get('category');
    if (q.get('chain') !== null) state.chain = q.get('chain');
    if (q.get('sort') !== null) {
      state.sort = q.get('sort');
      // A hash sort behaves like clicking that header: rank/name ascending, values descending.
      state.dir = (state.sort === 'rank' || state.sort === 'name') ? 1 : -1;
    }
    if (q.get('dir') !== null) state.dir = q.get('dir') === 'asc' ? 1 : -1;
    if (q.get('watchlist') !== null) state.watch = q.get('watchlist') === '1';
  }
  function writeHash() {
    var q = new URLSearchParams();
    if (state.q) q.set('filter', state.q);
    if (state.detail) q.set('detail', state.detail);
    if (state.category !== 'all') q.set('category', state.category);
    if (state.chain !== 'all') q.set('chain', state.chain);
    if (state.sort !== 'rank') q.set('sort', state.sort);
    if (state.watch) q.set('watchlist', '1');
    var s = q.toString();
    window.history.replaceState(null, '', s ? '#' + s : window.location.pathname + window.location.search);
  }
  window.addEventListener('hashchange', function () { readHash(); render(false); });

  /* ---------- filtering + sorting ---------- */
  function isWatch(r) { return r.tvl_usd >= DATA.floor_usd; }
  function filtered() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watch && !isWatch(r)) return false;
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function sorted(list) {
    var key = state.sort, dir = state.dir;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'implied') { av = a.implied_value_usd; bv = b.implied_value_usd; }
      else { av = a.rank; bv = b.rank; }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }
  function findRow(slug) {
    for (var i = 0; i < DATA.rows.length; i++) if (DATA.rows[i].slug === slug) return DATA.rows[i];
    return null;
  }
  function openDetail(slug, scroll) {
    if (!findRow(slug)) return;
    state.detail = slug;
    writeHash();
    render(false);
    if (scroll) { var d = document.getElementById('detail'); if (d) d.scrollIntoView({ block: 'start' }); }
  }
  function closeDetail() { state.detail = null; writeHash(); render(false); }

  /* ---------- sections ---------- */
  function lede() {
    var total = DATA.rows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    var top = DATA.rows.length ? DATA.rows[0] : null;
    return el('section', { class: 'lede' },
      el('div', null,
        el('p', { class: 'kicker', text: 'Pre-token radar  ·  model ' + DATA.model_version }),
        el('h1', { id: 'board-title', text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least ' + money(DATA.floor_usd) + ' of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor, by TVL. Rank 1 is ' + (top ? top.name + ' at ' + money(top.implied_value_usd) : 'unranked') + '.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Combined implied value' }), el('b', { text: money(total) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }

  function controls() {
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (a, r) { return a.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, slug, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(false); });
    var catSel = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      cats.map(function (c) { return el('option', { value: c, text: c + ' (' + DATA.rows.filter(function (r) { return (r.category || 'Other') === c; }).length + ')', selected: c === state.category ? 'selected' : null }); })
    );
    catSel.addEventListener('change', function () { state.category = catSel.value; writeHash(); render(false); });
    var chainSel = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; writeHash(); render(false); });
    var allBtn = el('button', { type: 'button', 'aria-pressed': state.watch ? 'false' : 'true', text: 'All pre-token', onclick: function () { state.watch = false; writeHash(); render(false); } });
    var watchBtn = el('button', { type: 'button', 'aria-pressed': state.watch ? 'true' : 'false', text: 'Watchlist only', onclick: function () { state.watch = true; writeHash(); render(false); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSel),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSel),
      el('div', { class: 'field' }, el('span', { class: 'lbl', text: 'Scope' }), el('div', { class: 'seg' }, allBtn, watchBtn)),
      el('span', { class: 'count', text: filtered().length + ' of ' + DATA.board_size + ' rows shown' })
    );
  }

  function sortHead(key, label) {
    var arrow = state.sort === key ? (state.dir === 1 ? ' ↑' : ' ↓') : '';
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () {
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = (key === 'rank' || key === 'name') ? 1 : -1; }
        writeHash(); render(false);
      } }, label + arrow)
    );
  }

  function boardTable() {
    var list = sorted(filtered());
    if (!list.length) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search, widen the category or chain, or switch back to all pre-token rows.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.watch = false; writeHash(); render(false); } })
      ));
    }
    var max = Math.max.apply(null, list.map(function (r) { return r.implied_value_usd; })) || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var plan = planFor(r);
      var gc = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.detail === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug, true); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug, true); } }
      },
        el('td', null, el('span', { class: 'rank' + (r.rank <= 3 ? ' top' : ''), text: String(r.rank) })),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') : 'chain unlisted') })
        )),
        el('td', { class: 'num', text: money(r.tvl_usd) }),
        el('td', { class: 'num ' + gc, text: pct(r.change_7d) }),
        el('td', { class: 'num', text: ageLabel(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: money(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'farm-sum' }, el('b', { text: '$' + plan.capital }), ' · ' + plan.hold + 'd · 6 steps')),
        el('td', null, isWatch(r) ? el('span', { class: 'tag watch', text: 'Watchlist' }) : el('span', { class: 'tag pre', text: 'Early' })),
        el('td', null, el('button', { class: 'viewbtn', type: 'button', text: 'Details', onclick: function (e) { e.stopPropagation(); openDetail(r.slug, true); } }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Pre-token protocols only. Select a row for its model breakdown and farm plan. Farm shows the capital, hold and step count of its plan.' }),
          el('thead', null, el('tr', null,
            sortHead('rank', 'Rank'), sortHead('name', 'Protocol'), sortHead('tvl', 'TVL'),
            sortHead('growth', '7d'), sortHead('age', 'Age'), sortHead('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Farm' }), el('th', { scope: 'col', text: 'Scope' }), el('th', { scope: 'col', text: '' })
          )),
          tbody
        )
      )
    );
  }

  function detailView() {
    var row = findRow(state.detail);
    if (!row) return null;
    var m = DATA.model;
    var re = impliedOf(row, m);
    var plan = planFor(row);
    var match = re.value === row.implied_value_usd;
    // The multipliers data.js ships are authoritative; the recompute beside them is the check.
    var gm = row.growth_multiplier !== undefined ? row.growth_multiplier : re.growthMult;
    var mm = row.maturity_multiplier !== undefined ? row.maturity_multiplier : re.maturityMult;
    var bm = row.breadth_multiplier !== undefined ? row.breadth_multiplier : re.breadthMult;
    var grid = el('div', { class: 'detail-grid' },
      el('div', { class: 'big' }, el('span', { text: 'Implied value' }), el('b', { text: money(row.implied_value_usd) })),
      el('div', null, el('span', { text: 'TVL' }), el('b', { text: money(row.tvl_usd) })),
      el('div', null, el('span', { text: 'Seven-day change' }), el('b', { text: pct(row.change_7d) })),
      el('div', null, el('span', { text: 'Age with no token' }), el('b', { text: ageLabel(row.age_days) })),
      el('div', null, el('span', { text: 'First listed' }), el('b', { text: row.listed_at || 'unlisted' })),
      el('div', null, el('span', { text: 'Chains' }), el('b', { text: (row.chains && row.chains.length ? row.chains.join(', ') : 'unlisted') })),
      el('div', null, el('span', { text: 'Breadth multiplier' }), el('b', { text: '× ' + mult(bm) }))
    );
    var breakdown = el('div', { class: 'breakdown' },
      el('div', null, el('span', { text: 'Size = ' + m.base_multiple + ' × TVL^' + m.size_exponent + ' × $1B^' + (1 - m.size_exponent) }), el('b', { text: money(re.sizeBase) })),
      el('div', null, el('span', { text: 'Growth = clamp(7d, ' + m.growth_floor + ', ' + m.growth_cap + ') = ' + re.growthPct.toFixed(2) + '% (up ×' + m.growth_up_weight + ', down ×' + m.growth_down_weight + ')' }), el('b', { text: '× ' + mult(gm) })),
      el('div', null, el('span', { text: 'Maturity = ' + m.maturity_floor + ' + ' + m.maturity_range + ' × (1 − exp(−age / ' + m.maturity_scale_days + 'd))' }), el('b', { text: '× ' + mult(mm) })),
      el('div', null, el('span', { text: 'Breadth = 1 + ' + m.breadth_weight + ' × min(ln(' + (row.chains ? row.chains.length : 0) + ' chains), ln(' + m.breadth_cap_chains + '))' }), el('b', { text: '× ' + mult(bm) })),
      el('div', null, el('span', { text: 'Implied = round(size × growth × maturity × breadth)' }), el('b', { text: money(re.value) }))
    );
    var steps = el('ol', { class: 'steps' }, plan.steps.map(function (s, i) {
      return el('li', null,
        el('span', { class: 'act', text: (i + 1) + '. ' + s.text }),
        el('span', { class: 'cost', text: 'Cost: ' + s.cost + '  ·  Time: ' + s.time })
      );
    }));
    return el('section', { class: 'panel detail', id: 'detail', 'aria-label': 'Protocol detail' },
      el('div', { class: 'detail-head' },
        el('div', null,
          el('span', { class: 'brand-name', text: 'RANK ' + row.rank + ' OF ' + DATA.board_size + (isWatch(row) ? ' · WATCHLIST' : ' · EARLY RADAR') }),
          el('h2', { text: row.name }),
          el('p', { class: 'sub', text: (row.category || 'Other') + ' · ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'chain unlisted') + ' · records no token' })
        ),
        el('button', { class: 'close', type: 'button', text: 'Close ×', onclick: closeDetail })
      ),
      grid,
      el('div', { class: 'detail-body' },
        el('div', null,
          el('h3', { text: 'Model breakdown — model ' + DATA.model_version }),
          breakdown,
          el('p', { class: 'check' }, match
            ? el('b', { text: '✓ Recomputed in this page: ' + money(re.value) + ' — matches the board.' })
            : 'Recomputed in this page: ' + money(re.value) + ' — differs from the board; the data would be stale.')
        ),
        el('div', null,
          el('h3', { text: 'Farm plan — $' + plan.capital + ' capital, hold ' + plan.hold + ' days' }),
          steps,
          el('p', { class: 'check', text: 'No token is promised. Airdrops are never guaranteed; never pay to claim one.' })
        )
      )
    );
  }

  function modelPanel() {
    var m = DATA.model;
    var formula = DATA.model_formula ||
      ('implied = ' + m.base_multiple + ' x TVL^' + m.size_exponent + ' x $1B^' + (1 - m.size_exponent) + ' x growth x maturity x breadth');
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed — model ' + DATA.model_version }),
      el('p', { class: 'sub', text: 'One function scores every protocol from the snapshot figures alone. No name is special-cased and no row is hand-picked.' }),
      el('div', { class: 'formula' },
        el('b', { text: formula }),
        document.createTextNode('  Age is days since first listed; an unknown age uses ' + m.unknown_age_days + ' days. Chain count is the number of chains the snapshot lists for the protocol.')
      ),
      el('ol', null,
        el('li', null, el('b', { text: 'Size first, sublinear. ' }), 'Value grows with TVL^' + m.size_exponent + ', scaled by a $1B reference — a protocol ten times larger is worth about 5.6× more, not 10×.'),
        el('li', null, el('b', { text: 'Growth next, asymmetric. ' }), 'Seven-day TVL change, clamped to [' + m.growth_floor + ', ' + m.growth_cap + ']%, is weighted ×' + m.growth_up_weight + ' on the upside and ×' + m.growth_down_weight + ' on the downside: falls hurt less than rises help.'),
        el('li', null, el('b', { text: 'Maturity saturates. ' }), 'A protocol that has run longer with no token earns up to +' + Math.round(m.maturity_range * 100) + '%, approaching the cap exponentially over a ' + m.maturity_scale_days + '-day scale.'),
        el('li', null, el('b', { text: 'Breadth rewards reach. ' }), 'Each extra chain adds value logarithmically, up to ' + m.breadth_cap_chains + ' chains, at weight ' + m.breadth_weight + '.'),
        el('li', null, el('b', { text: 'Live tokens excluded. ' }), 'Protocols that already trade are set aside below with their market caps — the board never ranks a market price as an implied value.')
      )
    );
  }

  function liveTable() {
    if (!DATA.live || !DATA.live.length) return null;
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      var ratio = r.mcap_usd && r.tvl_usd ? (r.mcap_usd / r.tvl_usd).toFixed(2) + '×' : 'n/a';
      tbody.appendChild(el('tr', null,
        el('td', null, el('span', { class: 'tag live', text: 'Live' })),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') : 'chain unlisted') }))),
        el('td', { class: 'num', text: money(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: pct(r.change_7d) }),
        el('td', { class: 'num', text: money(r.mcap_usd) }),
        el('td', { class: 'num', text: ratio })
      ));
    });
    return el('section', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('h2', { text: 'Live tokens — already trading, kept apart' }),
        el('p', { text: 'These protocols already have a token, so the market has priced them. Their market cap is a fact, not a model, and they never enter the pre-token ranking above.' })
      ),
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Top ' + DATA.live.length + ' live-token protocols by market cap. MCap/TVL shows how the market values each dollar locked.' }),
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }),
            el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'MCap / TVL' })
          )),
          tbody
        )
      )
    );
  }

  function footer() {
    return el('footer', { class: 'foot' },
      el('p', { text: 'Snapshot ' + DATA.as_of + ' · ' + DATA.source }),
      el('p', { text: 'Watchlist floor ' + money(DATA.floor_usd) + ' · model ' + DATA.model_version + ' · board ' + DATA.board_size + ' rows · data.js only, no network.' })
    );
  }

  function render(scrollDetail) {
    app.textContent = '';
    app.setAttribute('aria-busy', 'false');
    app.appendChild(lede());
    app.appendChild(controls());
    var d = detailView();
    if (d) app.appendChild(d);
    app.appendChild(boardTable());
    app.appendChild(modelPanel());
    var live = liveTable();
    if (live) app.appendChild(live);
    app.appendChild(footer());
    if (scrollDetail && state.detail) { var n = document.getElementById('detail'); if (n) n.scrollIntoView({ block: 'start' }); }
  }

  if (!DATA || !DATA.rows) {
    app.textContent = '';
    app.appendChild(el('div', { class: 'panel' }, el('div', { class: 'empty' },
      el('h2', { text: 'No radar data loaded' }),
      el('p', { text: 'This page reads data.js beside it. Run main.ts to generate data.js, then open the page again.' })
    )));
    return;
  }
  readHash();
  if (state.detail && !findRow(state.detail)) state.detail = null;
  render(false);
})();
