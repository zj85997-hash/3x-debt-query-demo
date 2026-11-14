// 进程内指标登记表：计数器、耗时直方图、瞬时值。
// 每个进程每秒把快照写入 Redis，由 /ops 与 /metrics 汇总成全集群视图（见 modules/ops.mjs）。
export const BUCKETS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

const counters = new Map();
const histograms = new Map();
const gauges = new Map();

export function inc(name, label = '', by = 1) {
  const key = label ? name + '|' + label : name;
  counters.set(key, (counters.get(key) || 0) + by);
}
export function observe(name, label, ms) {
  const key = label ? name + '|' + label : name;
  let h = histograms.get(key);
  if (!h) histograms.set(key, h = {b: new Array(BUCKETS_MS.length + 1).fill(0), s: 0, c: 0});
  let i = 0;
  while (i < BUCKETS_MS.length && ms > BUCKETS_MS[i]) i++;
  h.b[i]++;
  h.s += ms;
  h.c++;
}
/** 注册瞬时值：传入函数则每次快照时求值 */
export function gauge(name, valueOrFn) { gauges.set(name, valueOrFn); }

export function snapshot() {
  const g = {};
  for (const [name, v] of gauges) {
    try { g[name] = typeof v === 'function' ? v() : v; } catch { g[name] = null; }
  }
  return {ts: Date.now(), counters: Object.fromEntries(counters), histograms: Object.fromEntries(histograms), gauges: g};
}
