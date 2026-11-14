// 运行大盘（原生 ES 模块）。每秒拉取一次全集群汇总快照，在浏览器里算出速率、分位耗时与占比。
// 约定：所有来自接口的字符串一律用 textContent 写入页面；图表数值同时提供"表格视图"。
const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}
function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}
const trim = s => s.replace(/\.0+$|(\.\d*[1-9])0+$/, '$1');
function fmt(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (v >= 10000) return trim((v / 10000).toFixed(v >= 1e6 ? 0 : 1)) + '万';
  if (v >= 100) return Math.round(v).toLocaleString('zh-CN');
  return trim(v.toFixed(v >= 10 ? Math.min(digits, 1) : digits));
}
const clock = ts => new Date(ts).toLocaleTimeString('zh-CN', {hour12: false});
const short = id => id.replace(/^.*-(api-\d+|worker)$/, '$1');

// ── 令牌：从地址栏 #token= 读取后立即抹掉，只保存在当前标签页
let token = sessionStorage.getItem('opsToken') || '';
const fromHash = location.hash.match(/token=([A-Za-z0-9]+)/);
if (fromHash) { token = fromHash[1]; sessionStorage.setItem('opsToken', token); history.replaceState(null, '', location.pathname); }

// ── 快照缓冲与派生指标
const snaps = [];
let windowSec = 120;
let BOUNDS = [];
const isApi = route => route.includes(' /api/v1/');
function digest(snap) {
  const sum = {total: 0, ok: 0, limited: 0, busy: 0, failed: 0, routes: new Map()};
  for (const [key, value] of Object.entries(snap.counters)) {
    if (!key.startsWith('http_requests|')) continue;
    const label = key.slice(14);
    const cut = label.lastIndexOf(',');
    const route = label.slice(0, cut), status = Number(label.slice(cut + 1));
    if (!isApi(route)) continue;
    const r = sum.routes.get(route) || {total: 0, protect: 0, failed: 0};
    r.total += value;
    sum.total += value;
    if (status === 429) { sum.limited += value; r.protect += value; }
    else if (status === 503) { sum.busy += value; r.protect += value; }
    else if (status >= 500) { sum.failed += value; r.failed += value; }
    else sum.ok += value;
    sum.routes.set(route, r);
  }
  snap.sum = sum;
  return snap;
}
const ago = seconds => {
  const target = snaps.at(-1).ts - seconds * 1000;
  return snaps.find(s => s.ts >= target) || snaps[0];
};
const VERIFY = 'POST /api/v1/verify';   // 实名核验的耗时由外部供应商决定，统计"自身耗时"时单列
function histDelta(from, to, only) {
  const out = new Array(BOUNDS.length + 1).fill(0);
  for (const [key, h] of Object.entries(to.histograms)) {
    if (!key.startsWith('http_ms|')) continue;
    const route = key.slice(8);
    if (only ? route !== only : !isApi(route) || route === VERIFY) continue;
    const before = from.histograms[key];
    h.b.forEach((n, i) => { out[i] += Math.max(0, n - (before ? before.b[i] : 0)); });
  }
  return out;
}
function percentile(buckets, p) {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const target = total * p;
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    if (seen + buckets[i] >= target) {
      const low = i === 0 ? 0 : BOUNDS[i - 1];
      const high = i < BOUNDS.length ? BOUNDS[i] : BOUNDS.at(-1) * 2;
      return low + (high - low) * ((target - seen) / buckets[i]);
    }
    seen += buckets[i];
  }
  return BOUNDS.at(-1);
}
const gaugeSum = (snap, name, role = 'api') => snap.instances.filter(i => i.role === role).reduce((a, i) => a + (i.gauges[name] || 0), 0);
const counter = (snap, ...names) => names.reduce((a, n) => a + (snap.counters[n] || 0), 0);
const counterPrefix = (snap, prefix) => Object.entries(snap.counters).reduce((a, [k, v]) => (k.startsWith(prefix) ? a + v : a), 0);

// ── 浮动提示（悬停与键盘聚焦显示同样的内容）
function makeTip(host) {
  const tip = el('div', {class: 'tip', hidden: true, role: 'tooltip'});
  host.append(tip);
  return {
    show(x, y, title, rows) {
      tip.replaceChildren(el('div', {class: 'tip-title', text: title}), ...rows.map(r =>
        el('div', {class: 'tip-row ' + (r.cls || '')}, [r.cls ? el('i', {class: r.box ? 'box' : ''}) : null, el('b', {text: r.value}), el('span', {text: r.name})])));
      tip.hidden = false;
      const width = tip.offsetWidth, hostWidth = host.clientWidth;
      tip.style.left = Math.max(0, x + 12 + width > hostWidth ? x - width - 12 : x + 12) + 'px';
      tip.style.top = Math.max(0, y) + 'px';
    },
    hide() { tip.hidden = true; }
  };
}

// ── 折线图：细线 2px、末端圆点带底色描边、网格为实线细线、十字准星 + 汇总提示、可切换表格视图
function niceScale(max) {
  if (!(max > 0)) return {top: 1, steps: 4};
  const pow = 10 ** Math.floor(Math.log10(max));
  const n = max / pow;
  const [mult, steps] = n <= 1 ? [1, 4] : n <= 2 ? [2, 4] : n <= 4 ? [4, 4] : n <= 5 ? [5, 5] : n <= 8 ? [8, 4] : [10, 5];
  return {top: mult * pow, steps};
}
class LineChart {
  constructor(figure, {title, subtitle, unit, series, area = false}) {
    Object.assign(this, {unit, series, area, points: [], hover: null, tableOn: false});
    this.toggle = el('button', {class: 'btn-ghost btn-xs', type: 'button', text: '表格视图'});
    this.plot = el('div', {class: 'plot', tabindex: '0', role: 'group', 'aria-label': title + '（左右方向键逐秒查看）'});
    this.svg = svg('svg', {role: 'img', 'aria-label': title});
    this.plot.append(this.svg);
    this.tip = makeTip(this.plot);
    this.tableWrap = el('div', {class: 'chart-table', hidden: true});
    figure.replaceChildren(...[
      el('div', {class: 'chart-head'}, [el('div', {}, [el('h2', {text: title}), el('span', {class: 'muted', text: subtitle})]), this.toggle]),
      series.length > 1 ? el('div', {class: 'legend'}, series.map(s => el('span', {class: s.cls}, [el('i'), document.createTextNode(s.name)]))) : null,
      this.plot, this.tableWrap].filter(Boolean));
    figure.querySelector('.chart-head > div').className = 'chart-title';
    this.toggle.addEventListener('click', () => {
      this.tableOn = !this.tableOn;
      this.plot.hidden = this.tableOn;
      this.tableWrap.hidden = !this.tableOn;
      this.toggle.textContent = this.tableOn ? '图表视图' : '表格视图';
      this.draw();
    });
    this.plot.addEventListener('pointermove', event => { this.pointerX = event.clientX - this.plot.getBoundingClientRect().left; this.pick(); });
    this.plot.addEventListener('pointerleave', () => { this.pointerX = null; this.hover = null; this.draw(); });
    this.plot.addEventListener('focus', () => { if (this.hover === null && this.points.length) { this.hover = this.points.length - 1; this.draw(); } });
    this.plot.addEventListener('blur', () => { if (this.pointerX === null || this.pointerX === undefined) { this.hover = null; this.draw(); } });
    this.plot.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Escape'].includes(event.key) || !this.points.length) return;
      event.preventDefault();
      if (event.key === 'Escape') this.hover = null;
      else this.hover = Math.max(0, Math.min(this.points.length - 1, (this.hover ?? this.points.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1)));
      this.pointerX = null;
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(this.plot);
  }
  update(points, seconds) { this.points = points; this.seconds = seconds; if (this.pointerX != null) this.pick(false); this.draw(); }
  pick(redraw = true) {
    if (!this.points.length || !this.geom) return;
    let best = 0, distance = Infinity;
    this.points.forEach((p, i) => { const d = Math.abs(this.geom.x(p.t) - this.pointerX); if (d < distance) { distance = d; best = i; } });
    this.hover = best;
    if (redraw) this.draw();
  }
  draw() {
    if (this.tableOn) return this.drawTable();
    const W = this.plot.clientWidth, H = 230;
    if (!W) return;
    const multi = this.series.length > 1;
    const m = {l: 46, r: multi ? 76 : 18, t: 12, b: 24};
    const points = this.points;
    const end = points.length ? points.at(-1).t : Date.now();
    const start = end - this.seconds * 1000;
    const x = t => m.l + (t - start) / (end - start) * (W - m.l - m.r);
    const max = Math.max(0, ...points.flatMap(p => this.series.map(s => p.v[s.key] ?? 0)));
    const {top, steps} = niceScale(max);
    const y = v => H - m.b - v / top * (H - m.t - m.b);
    this.geom = {x};
    const g = [];
    for (let i = 0; i <= steps; i++) {
      const value = top / steps * i, yy = y(value);
      g.push(svg('line', {class: i ? 'grid-line' : 'axis-line', x1: m.l, x2: W - m.r, y1: yy, y2: yy}));
      g.push(svg('text', {class: 'tick', x: m.l - 8, y: yy + 4, 'text-anchor': 'end'}, fmt(value, 2)));
    }
    const span = this.seconds;
    [[start, span >= 120 ? `${span / 60} 分钟前` : `${span} 秒前`, 'start'], [start + (end - start) / 2, span >= 120 ? `${trim((span / 120).toFixed(1))} 分钟前` : `${span / 2} 秒前`, 'middle'], [end, '现在', 'end']]
      .forEach(([t, label, anchor]) => g.push(svg('text', {class: 'tick', x: x(t), y: H - 6, 'text-anchor': anchor}, label)));
    if (!points.length) g.push(svg('text', {class: 'tick', x: (m.l + W - m.r) / 2, y: H / 2, 'text-anchor': 'middle'}, '等待数据…'));

    const ends = [];
    for (const s of this.series) {
      let d = '', pen = false, first = null, last = null;
      for (const p of points) {
        const value = p.v[s.key];
        if (value === null || value === undefined || p.t < start) { pen = false; continue; }
        d += (pen ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(value).toFixed(1);
        pen = true;
        first ??= p;
        last = p;
      }
      if (!d) continue;
      if (this.area && !multi) g.push(svg('path', {class: 'area fill-key ' + s.cls, d: `${d}L${x(last.t).toFixed(1)} ${y(0)}L${x(first.t).toFixed(1)} ${y(0)}Z`}));
      g.push(svg('path', {class: 'line stroke-key ' + s.cls, d}));
      ends.push({s, p: last, yy: y(last.v[s.key])});
    }
    // 末端直接标注：仅当标签互不拥挤时才画，否则交给图例与提示（不硬挤、不错位）
    const crowded = ends.some((a, i) => ends.some((b, j) => j > i && Math.abs(a.yy - b.yy) < 13));
    for (const {s, p, yy} of ends) {
      g.push(svg('circle', {class: 'dot fill-key ' + s.cls, cx: x(p.t), cy: yy, r: 4}));
      if (multi && !crowded) g.push(svg('text', {class: 'end-label', x: x(p.t) + 9, y: yy + 4}, `${s.name} ${fmt(p.v[s.key])}`));
    }
    if (this.hover !== null && points[this.hover]) {
      const p = points[this.hover], xx = x(p.t);
      g.push(svg('line', {class: 'cross', x1: xx, x2: xx, y1: m.t, y2: H - m.b}));
      for (const s of this.series) if (p.v[s.key] != null) g.push(svg('circle', {class: 'dot fill-key ' + s.cls, cx: xx, cy: y(p.v[s.key]), r: 4.5}));
      this.tip.show(xx, m.t, clock(p.t), this.series.map(s => ({cls: s.cls, value: fmt(p.v[s.key]) + (p.v[s.key] == null ? '' : ' ' + this.unit), name: s.name})));
    } else this.tip.hide();
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.svg.replaceChildren(...g);
  }
  drawTable() {
    const rows = this.points.slice(-40).reverse();
    this.tableWrap.replaceChildren(el('table', {class: 'data-table'}, [
      el('thead', {}, el('tr', {}, [el('th', {text: '时间'}), ...this.series.map(s => el('th', {class: 'num', text: `${s.name}（${this.unit}）`}))])),
      el('tbody', {}, rows.map(p => el('tr', {}, [el('td', {text: clock(p.t)}), ...this.series.map(s => el('td', {class: 'num', text: fmt(p.v[s.key])}))])))
    ]));
  }
}

// ── 指标卡
const TILES = [
  {id: 'active', label: '近 60 秒活跃用户', unit: '人', spark: true},
  {id: 'rps', label: '每秒请求', unit: '次/秒', spark: true},
  {id: 'avail', label: '可用性（近 10 秒）', unit: '%'},
  {id: 'p95', label: 'P95 耗时（不含核验）', unit: 'ms', spark: true},
  {id: 'inflight', label: '在途请求', unit: '', meter: true},
  {id: 'queue', label: '核验排队', unit: '人', meter: true}
];
const tiles = {};
for (const t of TILES) {
  const value = el('span', {text: '—'}), unit = el('small', {text: t.unit}), sub = el('div', {class: 'tile-sub'});
  const extra = t.spark ? svg('svg', {'aria-hidden': 'true'}) : t.meter ? el('div', {class: 'meter'}, el('span')) : null;
  $('tiles').append(el('div', {class: 'tile'}, [el('div', {class: 'tile-label', text: t.label}), el('div', {class: 'tile-value'}, [value, unit]), sub, extra]));
  tiles[t.id] = {value, sub, extra, series: []};
}
function setTile(id, text, sub = '') { tiles[id].value.textContent = text; tiles[id].sub.textContent = sub; }
function spark(id, value) {
  const t = tiles[id];
  t.series.push(value ?? 0);
  if (t.series.length > 40) t.series.shift();
  const max = Math.max(1e-9, ...t.series), n = t.series.length, width = t.extra.clientWidth || 120;
  if (n < 2) return;
  const px = i => (i / (n - 1) * (width - 10) + 5).toFixed(1), py = v => (21 - v / max * 16).toFixed(1);
  t.extra.setAttribute('viewBox', `0 0 ${width} 26`);
  t.extra.replaceChildren(
    svg('polyline', {class: 'spark-line', points: t.series.map((v, i) => px(i) + ',' + py(v)).join(' ')}),
    svg('circle', {class: 'spark-now', cx: px(n - 1), cy: py(t.series.at(-1)), r: 3.5}));
}
function meter(id, ratio) {
  const m = tiles[id].extra;
  m.dataset.level = ratio >= 0.9 ? 'critical' : ratio >= 0.7 ? 'warning' : 'normal';   // 容量 70% 预警、90% 启动过载保护
  m.firstChild.style.width = Math.min(100, ratio * 100).toFixed(1) + '%';
}

// ── 图表实例
const chartRps = new LineChart($('chart-rps'), {title: '每秒请求数', subtitle: '业务接口合计', unit: '次/秒', area: true, series: [{key: 'rps', name: '每秒请求', cls: 'k1'}]});
const chartLat = new LineChart($('chart-lat'), {title: '接口耗时', subtitle: '不含实名核验 · 5 秒滑动窗口', unit: 'ms',
  series: [{key: 'p50', name: 'P50', cls: 'o1'}, {key: 'p95', name: 'P95', cls: 'o2'}, {key: 'p99', name: 'P99', cls: 'o3'}]});

function setStatus(node, level, text) { node.dataset.level = level; node.querySelector('.status-text').textContent = text; }
const statusNode = (level, text) => { const n = el('span', {class: 'status', 'data-level': level}, [el('span', {class: 'status-icon', 'aria-hidden': 'true'}), el('span', {class: 'status-text', text})]); return n; };

const funnelTip = makeTip($('funnel'));
const outcomeHost = el('div', {class: 'plot'});
$('outcome').append(outcomeHost);
const outcomeTip = makeTip(outcomeHost);
const STAGES = [['session', '进入页面'], ['verified', '核验通过'], ['query', '发起查询'], ['order_created', '创建订单'], ['order_paid', '支付成功']];
const OUTCOMES = [['outcome_own', '自有授权资产', 'k1'], ['outcome_history', '历史转让记录', 'k2'], ['outcome_candidate', '待人工核实', 'k3'], ['outcome_empty', '暂无记录', 'k4']];
const FLAGS = {
  maintenance: ['维护模式', '暂停全部业务接口（支付回调除外）'],
  unlock_off: ['关闭付费解锁', '支付渠道异常时使用'],
  callback_off: ['关闭人工预约', '客服暂时无法承接时使用'],
  new_session_off: ['暂停新用户进入', '极端高峰时优先保障已在流程中的用户']
};
for (const button of document.querySelectorAll('[data-table]')) {
  button.addEventListener('click', () => {
    const name = button.dataset.table, table = $(name + '-table'), chart = $(name);
    table.hidden = !table.hidden;
    chart.hidden = !table.hidden;
    button.textContent = table.hidden ? '表格视图' : '图表视图';
  });
}

function render() {
  const now = snaps.at(-1), prev = snaps.at(-2) || now, ten = ago(10);
  BOUNDS = now.bucketsMs;
  $('day').textContent = now.day;
  $('updated').textContent = '更新于 ' + clock(now.ts);
  const apis = now.instances.filter(i => i.role === 'api').sort((a, b) => a.id.localeCompare(b.id));
  const worker = now.instances.find(i => i.role === 'worker');

  // 指标卡
  const seconds = Math.max(1, (now.ts - ten.ts) / 1000);
  const d = k => Math.max(0, now.sum[k] - ten.sum[k]);
  const rps = d('total') / seconds;
  const p95 = percentile(histDelta(ten, now), 0.95);
  setTile('active', now.active60s === null ? '—' : fmt(now.active60s), `今日进入 ${fmt(now.stats.session || 0)} 人次`);
  spark('active', now.active60s);
  setTile('rps', fmt(rps), `累计 ${fmt(now.sum.total)} 次`);
  spark('rps', Math.max(0, now.sum.total - prev.sum.total) / Math.max(0.2, (now.ts - prev.ts) / 1000));
  const bad = d('failed') + d('busy');
  setTile('avail', d('total') ? trim(((1 - bad / d('total')) * 100).toFixed(2)) : '—', d('total') ? `失败或繁忙 ${fmt(bad)} 次 · 限流 ${fmt(d('limited'))} 次` : '近 10 秒无请求');
  const verifyP95 = percentile(histDelta(ten, now, VERIFY), 0.95);
  setTile('p95', p95 === null ? '—' : fmt(p95), p95 === null ? '近 10 秒无请求' : `P99 ${fmt(percentile(histDelta(ten, now), 0.99))} ms · 核验 P95 ${fmt(verifyP95)} ms`);
  spark('p95', p95);
  const inflight = gaugeSum(now, 'in_flight'), capacity = now.limits.maxInFlight * Math.max(1, apis.length);
  setTile('inflight', fmt(inflight), `容量 ${fmt(capacity)} · ${apis.length} 个 API 进程`);
  meter('inflight', inflight / capacity);
  const queued = gaugeSum(now, 'bulkhead_queued|verify'), verifying = gaugeSum(now, 'bulkhead_active|verify'), verifyCap = now.limits.verifyConcurrency * Math.max(1, apis.length);
  setTile('queue', fmt(queued), `核验中 ${fmt(verifying)} / 并发上限 ${fmt(verifyCap)}`);
  meter('queue', verifying / verifyCap);

  // 折线图
  const from = now.ts - windowSec * 1000;
  const points = [];
  for (let i = 1; i < snaps.length; i++) {
    const s = snaps[i], p = snaps[i - 1];
    if (s.ts < from) continue;
    const dt = Math.max(0.2, (s.ts - p.ts) / 1000);
    const delta = histDelta(snaps[Math.max(0, i - 5)], s);
    points.push({t: s.ts, v: {rps: Math.max(0, s.sum.total - p.sum.total) / dt, p50: percentile(delta, 0.5), p95: percentile(delta, 0.95), p99: percentile(delta, 0.99)}});
  }
  chartRps.update(points, windowSec);
  chartLat.update(points, windowSec);

  // 实例负载
  const share = apis.map(i => Math.max(0, i.requests - (ten.instances.find(o => o.id === i.id)?.requests ?? i.requests)));
  const shareTotal = share.reduce((a, b) => a + b, 0);
  $('instances').replaceChildren(...apis.map((i, n) => {
    const ratio = shareTotal ? share[n] / shareTotal : 0;
    const bar = el('div', {class: 'meter', role: 'img', 'aria-label': `${short(i.id)} 承接 ${(ratio * 100).toFixed(1)}% 的请求`}, el('span'));
    bar.firstChild.style.width = (ratio * 100).toFixed(1) + '%';
    return el('div', {class: 'inst'}, [
      el('div', {class: 'inst-name'}, [document.createTextNode(short(i.id)), el('small', {text: `PID ${i.pid} · 已运行 ${fmt((now.ts - i.startedAt) / 60000, 0)} 分`})]),
      bar,
      el('div', {class: 'inst-fig'}, [el('b', {text: shareTotal ? (ratio * 100).toFixed(1) + '%' : '—'}), document.createTextNode(` · 在途 ${i.gauges.in_flight ?? 0} · 循环延迟 ${i.gauges.loop_lag_ms ?? 0} ms`)])
    ]);
  }), worker ? el('div', {class: 'inst'}, [
    el('div', {class: 'inst-name'}, [document.createTextNode('后台进程'), el('small', {text: `PID ${worker.pid}`})]),
    el('div', {class: 'muted', text: '审计批量落库 · 统计同步 · 超时订单关闭'}),
    el('div', {class: 'inst-fig'}, [el('b', {text: fmt(worker.gauges.worker_persisted ?? 0)}), document.createTextNode(' 条审计已落库')])
  ]) : null);

  // 依赖与保护
  const dbOpen = now.instances.some(i => i.db && i.db !== 'closed');
  const redisDown = now.degraded || apis.some(i => i.gauges.redis_ready === 0);
  const verifyOpen = apis.some(i => i.gauges['breaker_open|verify'] === 1);
  const payOpen = apis.some(i => i.gauges['breaker_open|pay'] === 1);
  const backlog = (now.stream?.length ?? 0) + gaugeSum(now, 'audit_fallback_pending');
  const deps = [
    ['MySQL 数据库', dbOpen ? ['critical', '断路保护中'] : ['good', '正常']],
    ['Redis', redisDown ? ['warning', '不可用 · 已降级'] : ['good', '正常']],
    ['实名核验供应商', verifyOpen ? ['critical', '熔断中'] : queued ? ['warning', `排队 ${fmt(queued)} 人`] : ['good', '正常']],
    ['支付渠道', payOpen ? ['critical', '熔断中'] : ['good', '正常']],
    ['审计流水', backlog > 2000 ? ['warning', `积压 ${fmt(backlog)} 条`] : ['good', backlog ? `待落库 ${fmt(backlog)} 条` : '实时落库']],
    ['后台进程', worker ? ['good', '运行中'] : ['critical', '未运行']]
  ];
  $('deps').replaceChildren(...deps.map(([name, [level, text]]) => el('li', {}, [el('span', {text: name}), statusNode(level, text)])));
  const protect = [
    ['限流拦截', counter(now, 'errors|RATE_LIMITED')],
    ['过载拒绝', counter(now, 'shed|normal', 'shed|critical')],
    ['核验排队超时', counter(now, 'bulkhead_rejected|verify,wait_timeout', 'bulkhead_rejected|verify,queue_full')],
    ['断路器跳闸', counterPrefix(now, 'breaker_opened|')],
    ['审计走备用通道', counter(now, 'audit_fallback')],
    ['重复请求被幂等拦下', counter(now, 'order_idempotent_hit', 'pay_notify|duplicate')]
  ];
  $('protect').replaceChildren(...protect.map(([name, value]) => el('div', {}, [el('dt', {text: name, title: name}), el('dd', {text: fmt(value)})])));

  const recent = k => Math.max(0, now.sum[k] - ten.sum[k]);
  const level = dbOpen || verifyOpen || payOpen || !worker ? 'critical' : redisDown || recent('busy') || backlog > 2000 ? 'warning' : 'good';
  setStatus($('overall'), level, dbOpen || verifyOpen || payOpen ? '依赖故障 · 保护中' : !worker ? '后台进程未运行' : redisDown ? '降级运行' : recent('busy') ? '高负载 · 保护动作生效' : '运行正常');

  // 业务漏斗（同一色条形，数值标在条端）
  const stats = now.stats, top = Math.max(1, ...STAGES.map(([k]) => stats[k] || 0));
  const funnelRows = STAGES.map(([key, name], i) => {
    const value = stats[key] || 0, before = i ? stats[STAGES[i - 1][0]] || 0 : 0;
    const rate = i && before ? (value / before * 100).toFixed(1) + '%' : '';
    const bar = el('div', {class: 'frow-bar'});
    bar.style.width = `calc((100% - 110px) * ${(value / top).toFixed(4)})`;   // 条长与数值成正比，右侧留出数值标签的位置
    const row = el('div', {class: 'frow', tabindex: '0', role: 'img', 'aria-label': `${name} ${value} 人次${rate ? '，较上一环节 ' + rate : ''}`}, [
      el('div', {class: 'frow-label', text: name}),
      el('div', {class: 'frow-track'}, [bar, el('div', {class: 'frow-value'}, [document.createTextNode(fmt(value)), rate ? el('small', {text: rate}) : null])])
    ]);
    const show = () => funnelTip.show(96, row.offsetTop + 22, name, [{value: fmt(value) + ' 人次', name: i ? `较上一环节 ${rate || '—'}` : '漏斗起点'}]);
    row.addEventListener('pointerenter', show);
    row.addEventListener('focus', show);
    row.addEventListener('pointerleave', funnelTip.hide);
    row.addEventListener('blur', funnelTip.hide);
    return row;
  });
  const keep = document.activeElement?.closest?.('.frow') ? [...$('funnel').querySelectorAll('.frow')].indexOf(document.activeElement) : -1;
  $('funnel').querySelectorAll('.frow').forEach(n => n.remove());
  $('funnel').prepend(...funnelRows);
  if (keep >= 0) funnelRows[keep]?.focus();
  $('funnel-side').textContent = `另：预约人工 ${fmt(stats.callback_created || 0)} 次（撤回 ${fmt(stats.callback_withdrawn || 0)}）· 核验未通过 ${fmt(stats.verify_fail || 0)} 次`;
  $('funnel-table').replaceChildren(
    el('thead', {}, el('tr', {}, [el('th', {text: '环节'}), el('th', {class: 'num', text: '人次'}), el('th', {class: 'num', text: '较上一环节'})])),
    el('tbody', {}, STAGES.map(([key, name], i) => el('tr', {}, [el('td', {text: name}), el('td', {class: 'num', text: fmt(stats[key] || 0)}),
      el('td', {class: 'num', text: i && stats[STAGES[i - 1][0]] ? ((stats[key] || 0) / stats[STAGES[i - 1][0]] * 100).toFixed(1) + '%' : '—'})]))));

  // 查询结果分布（高分段条 + 图例 + 表格）
  const parts = OUTCOMES.map(([key, name, cls]) => ({name, cls, value: stats[key] || 0}));
  const whole = parts.reduce((a, p) => a + p.value, 0);
  outcomeHost.querySelectorAll('.segbar, .legend, .empty').forEach(n => n.remove());
  if (!whole) outcomeHost.prepend(el('div', {class: 'empty', text: '今天还没有查询'}));
  else {
    const barNode = el('div', {class: 'segbar', role: 'group', 'aria-label': '查询结果分布'});
    for (const p of parts.filter(x => x.value > 0)) {
      const shareText = (p.value / whole * 100).toFixed(p.value / whole < 0.1 ? 1 : 0) + '%';
      const part = el('div', {class: 'part ' + p.cls, tabindex: '0', role: 'img', 'aria-label': `${p.name} ${p.value} 次，占 ${shareText}`});
      part.style.flex = `${p.value} 1 0`;
      barNode.append(part);
      const show = () => outcomeTip.show(part.offsetLeft, 34, p.name, [{cls: p.cls, box: true, value: fmt(p.value) + ' 次', name: '占 ' + shareText}]);
      part.addEventListener('pointerenter', show);
      part.addEventListener('focus', show);
      part.addEventListener('pointerleave', outcomeTip.hide);
      part.addEventListener('blur', outcomeTip.hide);
      part.dataset.share = shareText;
    }
    const legend = el('div', {class: 'legend'}, parts.map(p => el('span', {class: p.cls}, [el('i', {class: 'box'}), document.createTextNode(p.name)])));
    outcomeHost.prepend(barNode, legend);
    // 段内占比标签：量过宽度、放得下才写（放不下的由图例、提示与表格承载）
    for (const part of barNode.children) if (part.clientWidth >= 46) part.textContent = part.dataset.share;
  }
  $('outcome-table').replaceChildren(
    el('thead', {}, el('tr', {}, [el('th', {text: '结果'}), el('th', {class: 'num', text: '次数'}), el('th', {class: 'num', text: '占比'})])),
    el('tbody', {}, parts.map(p => el('tr', {}, [el('td', {text: p.name}), el('td', {class: 'num', text: fmt(p.value)}), el('td', {class: 'num', text: whole ? (p.value / whole * 100).toFixed(1) + '%' : '—'})]))));

  // 接口明细
  const routes = [...now.sum.routes.keys()].sort();
  $('routes').tBodies[0].replaceChildren(...routes.map(route => {
    const cur = now.sum.routes.get(route), old = ten.sum.routes.get(route) || {total: 0};
    return el('tr', {}, [
      el('td', {class: 'route', text: route.replace('/api/v1', '')}), el('td', {class: 'num', text: fmt(cur.total)}),
      el('td', {class: 'num', text: fmt(Math.max(0, cur.total - old.total) / seconds)}),
      el('td', {class: 'num', text: (v => (v === null ? '—' : fmt(v) + ' ms'))(percentile(histDelta(ten, now, route), 0.95))}),
      el('td', {class: 'num', text: fmt(cur.protect)}), el('td', {class: 'num', text: fmt(cur.failed)})
    ]);
  }));

  // 动态开关（正在操作时不重绘，避免打断）
  if (!$('flags').contains(document.activeElement)) {
    $('flags').replaceChildren(...Object.entries(FLAGS).map(([name, [title, hint]]) => {
      const input = el('input', {type: 'checkbox', role: 'switch', 'aria-label': title, checked: now.flags[name]});
      input.addEventListener('change', async () => {
        if (input.checked && !confirm(`确定开启"${title}"吗？${hint}。`)) { input.checked = false; return; }
        const response = await fetch('/ops/api/flags', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Ops-Token': token}, body: JSON.stringify({name, value: input.checked})});
        if (!response.ok) input.checked = !input.checked;
        input.blur();
      });
      return el('div', {class: 'flag'}, [el('div', {}, [el('b', {text: title}), el('small', {text: hint})]), el('label', {class: 'switch'}, [input, el('span')])]);
    }));
  }
}

// ── 轮询
let failures = 0;
async function tick() {
  if (!token) return showGate('');
  try {
    const response = await fetch('/ops/api/overview', {headers: {'X-Ops-Token': token}, cache: 'no-store'});
    if (response.status === 403) { token = ''; sessionStorage.removeItem('opsToken'); return showGate('令牌不正确'); }
    if (!response.ok) throw new Error('status ' + response.status);
    snaps.push(digest(await response.json()));
    if (snaps.length > 330) snaps.shift();
    failures = 0;
    $('gate').hidden = true;
    $('board').hidden = false;
    render();
  } catch {
    if (++failures >= 3) setStatus($('overall'), 'critical', '大盘连接中断');
  }
}
function showGate(message) {
  $('gate').hidden = false;
  $('board').hidden = true;
  $('gate-error').textContent = message;
  setStatus($('overall'), 'idle', '等待令牌');
}
$('gate').addEventListener('submit', event => {
  event.preventDefault();
  token = $('gate-token').value.trim();
  sessionStorage.setItem('opsToken', token);
  tick();
});
$('range').addEventListener('click', event => {
  const button = event.target.closest('button[data-sec]');
  if (!button) return;
  windowSec = Number(button.dataset.sec);
  for (const b of $('range').children) b.classList.toggle('is-on', b === button);
  if (snaps.length) render();
});
const THEMES = [['', '跟随系统'], ['light', '浅色'], ['dark', '深色']];
let themeIndex = 0;
$('theme').addEventListener('click', () => {
  themeIndex = (themeIndex + 1) % THEMES.length;
  const [value, label] = THEMES[themeIndex];
  if (value) document.documentElement.dataset.theme = value; else delete document.documentElement.dataset.theme;
  $('theme').textContent = label;
});
tick();
setInterval(tick, 1000);
