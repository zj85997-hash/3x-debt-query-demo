// 压测引擎 · 调度端
// 用法：在计划文件中 import {runPhase} 后顺序执行各阶段，再写出 JSON 报告。
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null);
const round = (v, d = 1) => (v === null || v === undefined ? null : Number(v.toFixed(d)));

/**
 * 执行一个压测阶段。
 * @param {object} o
 * @param {string} o.name        阶段名
 * @param {string} o.scenario    场景模块的绝对 URL（import.meta.resolve 得到）
 * @param {string} o.base        被测服务地址
 * @param {number} o.vus         虚拟用户数
 * @param {'loop'|'once'} o.mode loop=持续循环；once=全部虚拟用户同一时刻各执行一次（洪峰）
 * @param {number} o.durationMs  loop 模式持续时长
 * @param {[number,number]} o.think 两次迭代之间的思考时间范围（毫秒）
 * @param {number} o.rampMs      loop 模式下的起量时间
 */
export async function runPhase(o) {
  const {name, scenario, base, vus, mode = 'loop', durationMs = 0, think = [0, 0], rampMs = 0,
    workers = 3, params = {}, timeoutMs = 10000, onStart} = o;
  const W = Math.max(1, Math.min(workers, vus));
  const threads = [];
  let next = 0;
  for (let i = 0; i < W; i++) {
    const count = Math.floor(vus / W) + (i < vus % W ? 1 : 0);
    threads.push(new Worker(new URL('./vu-worker.mjs', import.meta.url), {workerData: {
      scenario, base, vuStart: next, vuCount: count, vuTotal: vus, durationMs, mode, think, rampMs, params, timeoutMs
    }}));
    next += count;
  }
  const inflight = new Array(W).fill(0);
  let peakInFlight = 0;
  const results = [];
  const done = threads.map((t, i) => new Promise((resolve, reject) => {
    t.on('error', reject);
    t.on('message', m => {
      if (m.type === 'inflight') {
        inflight[i] = m.v;
        const sum = inflight.reduce((a, b) => a + b, 0);
        if (sum > peakInFlight) peakInFlight = sum;
      } else if (m.type === 'done') { results.push(m); resolve(); }
    });
  }));
  await Promise.all(threads.map(t => new Promise((resolve, reject) => {
    const onMsg = m => { if (m.type === 'ready') { t.off('message', onMsg); resolve(); } };
    t.on('message', onMsg);
    t.once('error', reject);
  })));
  const startAt = Date.now() + 300;
  // 挂起探测：主线程每 500ms 打一次点。若两次打点间隔超过 5 秒，说明压测机在本阶段中途被挂起过（例如系统休眠），本阶段数据作废
  let lastBeat = Date.now(), maxBeatGapMs = 0;
  const beat = setInterval(() => { const now = Date.now(); maxBeatGapMs = Math.max(maxBeatGapMs, now - lastBeat); lastBeat = now; }, 500);
  for (const t of threads) t.postMessage({startAt});
  const side = onStart ? onStart({startAt}) : null;
  await Promise.all(done);
  clearInterval(beat);
  maxBeatGapMs = Math.max(maxBeatGapMs, Date.now() - lastBeat);
  const sideResult = side ? await side : undefined;
  const elapsedMs = Date.now() - startAt;
  await Promise.all(threads.map(t => t.terminate()));

  // 合并各线程数据
  const merged = new Map();
  const distinct = new Map();
  for (const r of results) for (const [k, values] of Object.entries(r.collected || {})) {
    const set = distinct.get(k) || new Set();
    for (const v of values) set.add(v);
    distinct.set(k, set);
  }
  const seconds = Math.ceil(elapsedMs / 1000) + 1;
  const timeline = Array.from({length: seconds}, (_, s) => ({s, ok: 0, fail: 0}));
  for (const r of results) {
    for (const [metric, s] of Object.entries(r.series)) {
      const m = merged.get(metric) || {lats: [], requests: 0, soft: 0, status: {}, failKinds: {}};
      m.lats.push(s.lat);
      m.requests += s.requests;
      m.soft += s.soft || 0;
      for (const [k, v] of Object.entries(s.status)) m.status[k] = (m.status[k] || 0) + v;
      for (const [k, v] of Object.entries(s.failKinds)) m.failKinds[k] = (m.failKinds[k] || 0) + v;
      merged.set(metric, m);
    }
    for (let s = 0; s < seconds; s++) { timeline[s].ok += r.tlOk[s]; timeline[s].fail += r.tlFail[s]; }
  }
  // soft = 预期内的拒绝（排队、限流）。成功率 = 成功 ÷（请求 − soft）
  const summarize = (lats, requests, status, failKinds, soft = 0) => {
    const total = lats.reduce((a, l) => a + l.length, 0);
    const all = new Float32Array(total);
    let off = 0;
    for (const l of lats) { all.set(l, off); off += l.length; }
    all.sort();
    return {
      requests, ok: total, soft, fail: requests - total - soft,
      successRate: requests - soft ? round(total / (requests - soft), 5) : null,
      rps: round(requests / (elapsedMs / 1000), 1),
      p50: round(pct(all, 0.5)), p90: round(pct(all, 0.9)), p95: round(pct(all, 0.95)),
      p99: round(pct(all, 0.99)), max: round(all.length ? all[all.length - 1] : null),
      status, failKinds
    };
  };
  const metrics = {};
  const totals = {lats: [], requests: 0, soft: 0, status: {}, failKinds: {}};
  for (const [metric, m] of merged) {
    metrics[metric] = summarize(m.lats, m.requests, m.status, m.failKinds, m.soft);
    if (metric.startsWith('_') || metric.includes(':') || metric === 'journey') continue;   // 合计只统计真实 HTTP 请求
    totals.lats.push(...m.lats);
    totals.requests += m.requests;
    totals.soft += m.soft;
    for (const [k, v] of Object.entries(m.status)) totals.status[k] = (totals.status[k] || 0) + v;
    for (const [k, v] of Object.entries(m.failKinds)) totals.failKinds[k] = (totals.failKinds[k] || 0) + v;
  }
  const report = {
    name, mode, vus, durationMs, think, rampMs, loadThreads: W,
    elapsedSeconds: round(elapsedMs / 1000, 2), peakInFlight, maxTimerGapMs: maxBeatGapMs, suspended: maxBeatGapMs > 5000,
    total: summarize(totals.lats, totals.requests, totals.status, totals.failKinds, totals.soft),
    metrics, distinct: Object.fromEntries([...distinct].map(([k, set]) => [k, set.size])),
    timeline: mode === 'loop' ? timeline.slice(0, Math.ceil(durationMs / 1000)) : undefined,
    ...(sideResult !== undefined ? {side: sideResult} : {})
  };
  return report;
}

export function printPhase(r) {
  const t = r.total;
  console.log(`\n■ ${r.name}  [${r.mode}] VU=${r.vus} 用时=${r.elapsedSeconds}s 在途峰值=${r.peakInFlight}`);
  console.log(`  合计 请求=${t.requests} 成功率=${((t.successRate ?? 0) * 100).toFixed(2)}% 预期内拒绝=${t.soft} 失败=${t.fail} RPS=${t.rps} P50=${t.p50}ms P95=${t.p95}ms P99=${t.p99}ms MAX=${t.max}ms`);
  if (r.suspended) console.log(`  ⚠ 压测机在本阶段中途被挂起过（计时器最长停顿 ${r.maxTimerGapMs} ms，多为系统休眠），本阶段结果无效，请在不休眠的状态下重跑（macOS 可用 caffeinate -is 包住命令）`);
  const exhausted = Object.keys(t.failKinds).filter(k => /EADDRNOTAVAIL|EMFILE/.test(k));
  if (exhausted.length) console.log('  ⚠ 压测端自身资源耗尽（' + exhausted.join('、') + '），本阶段结果无效，请冷却后重跑');
  for (const [name, m] of Object.entries(r.metrics)) {
    if (name.startsWith('_') && !m.fail) continue;
    console.log(`  · ${name.padEnd(20)} n=${String(m.requests).padStart(7)} ok=${String(m.ok).padStart(7)}${m.soft ? ' soft=' + m.soft : ''} P50=${m.p50} P95=${m.p95} P99=${m.p99} MAX=${m.max}${Object.keys(m.status).length ? ' 状态=' + JSON.stringify(m.status) : ''}${m.fail ? ' 失败=' + JSON.stringify(m.failKinds) : ''}`);
  }
}

export const here = (meta, rel) => new URL(rel, meta.url).href;
export {once};
