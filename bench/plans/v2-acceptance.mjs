// V2 验收压测（npm run bench）：按事先写明的准出标准，验证"500 人同时使用"。
// 每个阶段结束后与数据库对账。只跑其中几项：ONLY=T1,T2 npm run bench；缩短稳态时长：T1_SECONDS=60
import {writeFile} from 'node:fs/promises';
import {runPhase, printPhase, here} from '../lib/engine.mjs';
import {base, overview, counts, integrity, waitDrained, reconcile, resetFaults, closeDb, sleep} from '../lib/stack.mjs';

const only = (process.env.ONLY || '').split(',').filter(Boolean);
const scenario = here(import.meta, '../scenarios/v2/journey.mjs');
const results = [];
const pct = v => (v * 100).toFixed(2) + '%';
// "硬失败"= 既不是成功、也不是预期内的排队/限流：5xx、超时、连接错误。预期内拒绝（soft）不算失败但单独统计。
const hardFailRate = r => (r.total.requests ? r.total.fail / r.total.requests : 0);
const journeyRate = r => r.metrics.journey?.successRate ?? 0;
const p95 = (r, name) => r.metrics[name]?.p95 ?? null;

async function phase(id, name, options, criteria) {
  if (only.length && !only.includes(id)) return;
  await resetFaults();
  await waitDrained(30000);
  const before = await counts();
  const report = await runPhase({base, scenario, name: `${id} ${name}`, workers: 4, ...options});
  const drainedMs = await waitDrained(60000);
  const after = await counts();
  report.id = id;
  report.reconcile = reconcile(before, after, report);
  report.integrity = await integrity();
  report.auditDrainedMs = drainedMs;
  report.checks = criteria.map(([label, actual, pass]) => ({label, actual: actual(report), pass: !!pass(report)}));
  report.checks.push({label: '数据库对账全部一致', actual: report.reconcile.rows.map(r => `${r.client}/${r.database}`).join(' '), pass: report.reconcile.allMatch});
  report.checks.push({label: '无重复支付、无重复预约、订单与解锁授权一一对应', actual: JSON.stringify(report.integrity), pass: Object.values(report.integrity).every(v => v === 0)});
  report.checks.push({label: '压测机全程未被挂起（无系统休眠干扰）', actual: `计时器最长停顿 ${report.maxTimerGapMs} ms`, pass: !report.suspended});
  report.passed = report.checks.every(c => c.pass);
  printPhase(report);
  for (const c of report.checks) console.log(`  ${c.pass ? '✔' : '✘'} ${c.label} —— 实测 ${c.actual}`);
  results.push(report);
  await sleep(5000);
}

const steadySeconds = Number(process.env.T1_SECONDS || 300);
await phase('T1', `稳态：500 人持续使用 ${steadySeconds} 秒（每步思考 1–3 秒）`,
  {vus: 500, durationMs: steadySeconds * 1000, think: [1000, 3000], rampMs: 10000}, [
    ['旅程成功率 ≥ 99.9%', r => pct(journeyRate(r)), r => journeyRate(r) >= 0.999],
    ['硬失败率 ≤ 0.1%', r => pct(hardFailRate(r)), r => hardFailRate(r) <= 0.001],
    ['查询接口 P95 ≤ 100 ms', r => p95(r, 'query') + ' ms', r => p95(r, 'query') <= 100],
    ['核验（含排队）P95 ≤ 1500 ms', r => p95(r, 'step:verify') + ' ms', r => p95(r, 'step:verify') <= 1500],
    ['下单 P95 ≤ 500 ms', r => p95(r, 'order.create') + ' ms', r => p95(r, 'order.create') <= 500],
    ['支付确认（回调到账）P95 ≤ 2000 ms', r => p95(r, 'step:pay.confirmed') + ' ms', r => p95(r, 'step:pay.confirmed') <= 2000]
  ]);

await phase('T2', '洪峰：500 人同一时刻进入并走完全程', {vus: 500, mode: 'once'}, [
  ['旅程成功率 ≥ 99.5%', r => pct(journeyRate(r)), r => journeyRate(r) >= 0.995],
  ['硬失败率 ≤ 0.5%', r => pct(hardFailRate(r)), r => hardFailRate(r) <= 0.005],
  ['全程（含排队）P95 ≤ 15 秒', r => p95(r, 'journey') + ' ms', r => p95(r, 'journey') <= 15000]
]);

await phase('T3', '高压：500 个请求持续在途 60 秒（无思考时间）', {vus: 500, durationMs: 60000}, [
  ['不雪崩：旅程成功率 ≥ 99%', r => pct(journeyRate(r)), r => journeyRate(r) >= 0.99],
  ['硬失败率 ≤ 0.5%', r => pct(hardFailRate(r)), r => hardFailRate(r) <= 0.005],
  ['查询接口 P95 ≤ 300 ms', r => p95(r, 'query') + ' ms', r => p95(r, 'query') <= 300]
]);

await phase('T4', '过载 2 倍：1000 个虚拟用户无间歇 30 秒', {vus: 1000, durationMs: 30000}, [
  ['柔性降级：旅程成功率 ≥ 95%', r => pct(journeyRate(r)), r => journeyRate(r) >= 0.95],
  ['硬失败率 ≤ 1%', r => pct(hardFailRate(r)), r => hardFailRate(r) <= 0.01]
]);

await phase('T5', '过载 4 倍：2000 个虚拟用户无间歇 30 秒', {vus: 2000, durationMs: 30000}, [
  ['柔性降级：旅程成功率 ≥ 90%', r => pct(journeyRate(r)), r => journeyRate(r) >= 0.90],
  ['硬失败率 ≤ 1%', r => pct(hardFailRate(r)), r => hardFailRate(r) <= 0.01]
]);

await phase('T6', '恢复确认：过载结束后立即回到 500 人常态 30 秒', {vus: 500, durationMs: 30000, think: [1000, 3000], rampMs: 3000}, [
  ['旅程成功率 ≥ 99.9%', r => pct(journeyRate(r)), r => journeyRate(r) >= 0.999],
  ['查询接口 P95 ≤ 100 ms', r => p95(r, 'query') + ' ms', r => p95(r, 'query') <= 100]
]);

const o = await overview().catch(() => null);
const file = process.env.REPORT || 'bench/reports/v2-acceptance.json';
await writeFile(file, JSON.stringify({date: new Date().toISOString(), target: 'V2', base,
  host: {cpu: 'Apple M4 · 10 核', mem: '16 GB', os: process.platform + ' ' + process.arch, node: process.version},
  topology: o ? {apiProcesses: o.instances.filter(i => i.role === 'api').length, limits: o.limits} : null,
  passed: results.every(r => r.passed), phases: results}, null, 2) + '\n');
console.log(`\n验收${results.every(r => r.passed) ? '通过' : '未通过'}，报告已写入 ${file}`);
await closeDb();
process.exit(results.every(r => r.passed) ? 0 : 1);
