// 立体监控的数据面：每个进程每秒把自己的指标快照写到 Redis，任何实例都能汇总出全集群视图。
// 对外两种形态：/ops/api/overview（给运营大盘的 JSON）与 /metrics（Prometheus 文本格式，接入云监控/告警）。
import {config} from '../config.mjs';
import {redis, key, redisReady} from '../infra/redis.mjs';
import {snapshot, BUCKETS_MS} from '../infra/metrics.mjs';
import {instanceId} from '../infra/logger.mjs';
import {allFlags} from '../infra/flags.mjs';
import {dbState} from '../infra/mysql.mjs';
import {STREAM, GROUP, setStreamBacklog} from './audit.mjs';
import {today, FUNNEL} from './stats.mjs';
import {activeUsers} from './presence.mjs';

const startedAt = Date.now();
let timer;
const mine = role => ({id: instanceId, role, pid: process.pid, startedAt, db: dbState(), ...snapshot()});

export function startSnapshots(role) {
  const publish = async () => {
    try {
      const now = Date.now();
      const results = await redis.pipeline()
        .set(key('m', instanceId), JSON.stringify(mine(role)), 'EX', 6)
        .zadd(key('m:alive'), now, instanceId)
        .xlen(STREAM)
        .exec();
      if (!results[2][0]) setStreamBacklog(Number(results[2][1]));
    } catch { /* Redis 不可用时本进程仍可通过自身接口被查看 */ }
  };
  timer = setInterval(publish, 1000);
  timer.unref();
  publish();
}
export function stopSnapshots() {
  clearInterval(timer);
  redis.zrem(key('m:alive'), instanceId).catch(() => {});
}

async function collect(role) {
  if (!redisReady()) return {instances: [mine(role)], degraded: true};
  try {
    const ids = await redis.zrangebyscore(key('m:alive'), Date.now() - 4000, '+inf');
    const raws = ids.length ? await redis.mget(ids.map(id => key('m', id))) : [];
    const instances = raws.filter(Boolean).map(raw => JSON.parse(raw));
    return {instances: instances.length ? instances : [mine(role)], degraded: false};
  } catch { return {instances: [mine(role)], degraded: true}; }
}
const pairs = flat => { const o = {}; for (let i = 0; i < flat.length; i += 2) o[flat[i]] = flat[i + 1]; return o; };

export async function overview(role = 'api') {
  const {instances, degraded} = await collect(role);
  const counters = {}, histograms = {};
  for (const inst of instances) {
    for (const [k, v] of Object.entries(inst.counters)) counters[k] = (counters[k] || 0) + v;
    for (const [k, h] of Object.entries(inst.histograms)) {
      const t = histograms[k] || (histograms[k] = {b: new Array(BUCKETS_MS.length + 1).fill(0), s: 0, c: 0});
      h.b.forEach((n, i) => { t.b[i] += n; });
      t.s += h.s; t.c += h.c;
    }
  }
  let stream = null, stats = {}, verifyBudgetUsed = null, active60s = null;
  if (!degraded) {
    try {
      const results = await redis.pipeline()
        .xlen(STREAM).xinfo('GROUPS', STREAM).hgetall(key('stat', today())).get(key('vbudget', today())).exec();
      const group = Array.isArray(results[1][1]) ? results[1][1].map(pairs).find(g => g.name === GROUP) : null;
      stream = {length: Number(results[0][1] || 0), pending: group ? Number(group.pending) : null, lag: group && group.lag !== null ? Number(group.lag) : null};
      const raw = results[2][1] || {};
      for (const metric of FUNNEL) stats[metric] = 0;
      for (const [field, value] of Object.entries(raw)) {
        const metric = field.split('|')[1];
        stats[metric] = (stats[metric] || 0) + Number(value);
      }
      verifyBudgetUsed = Number(results[3][1] || 0);
      active60s = await activeUsers();
    } catch { /* 部分信息缺失不影响大盘其余部分 */ }
  }
  return {
    ts: Date.now(), degraded, bucketsMs: BUCKETS_MS,
    instances: instances.map(i => ({id: i.id, role: i.role, pid: i.pid, startedAt: i.startedAt, ts: i.ts, db: i.db, gauges: i.gauges,
      // 该实例累计处理的业务请求数（大盘据此计算各实例的流量占比，观察负载是否均衡）
      requests: Object.entries(i.counters).reduce((sum, [k, v]) => (k.startsWith('http_requests|') && k.includes(' /api/v1/') ? sum + v : sum), 0)})),
    counters, histograms, stream, day: today(), stats, flags: allFlags(), active60s,
    limits: {maxInFlight: config.overload.maxInFlight, verifyConcurrency: config.verify.concurrency, dbPool: config.db.poolSize,
      verifyDailyBudget: config.limits.verifyDailyBudget, verifyBudgetUsed}
  };
}

const esc = v => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
export async function prometheusText(role = 'api') {
  const {instances} = await collect(role);
  const lines = [];
  for (const inst of instances) {
    const base = `instance="${esc(inst.id)}",role="${esc(inst.role)}"`;
    for (const [k, v] of Object.entries(inst.counters)) {
      const [name, label] = k.split('|');
      lines.push(`dq_${name}_total{${base}${label ? `,label="${esc(label)}"` : ''}} ${v}`);
    }
    for (const [k, v] of Object.entries(inst.gauges)) {
      if (v === null) continue;
      const [name, label] = k.split('|');
      lines.push(`dq_${name}{${base}${label ? `,label="${esc(label)}"` : ''}} ${v}`);
    }
    for (const [k, h] of Object.entries(inst.histograms)) {
      const [name, label] = k.split('|');
      const labels = `${base}${label ? `,label="${esc(label)}"` : ''}`;
      let acc = 0;
      BUCKETS_MS.forEach((le, i) => { acc += h.b[i]; lines.push(`dq_${name}_bucket{${labels},le="${le}"} ${acc}`); });
      lines.push(`dq_${name}_bucket{${labels},le="+Inf"} ${h.c}`, `dq_${name}_sum{${labels}} ${h.s.toFixed(3)}`, `dq_${name}_count{${labels}} ${h.c}`);
    }
  }
  return lines.join('\n') + '\n';
}
