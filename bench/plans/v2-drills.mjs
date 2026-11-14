// V2 故障演练（npm run drill）：在 300 人持续使用的同时，逐一制造故障，观察"是否影响用户、多久恢复、数据是否一致"。
// 每一项演练结束后都与数据库对账：压测端看到的成功次数必须等于数据库新增行数。
// 运行其中几项：ONLY=D1,D5 npm run drill
import {writeFile, readFile} from 'node:fs/promises';
import {runPhase, printPhase, here} from '../lib/engine.mjs';
import {env, base, overview, fault, resetFaults, counts, integrity, waitDrained, reconcile, signal, apiInstances, closeDb, sleep} from '../lib/stack.mjs';

const only = (process.env.ONLY || '').split(',').filter(Boolean);
const scenario = here(import.meta, '../scenarios/v2/journey.mjs');
const load = {scenario, base, vus: Number(process.env.VUS || 300), durationMs: 40000, think: [500, 1500], rampMs: 3000};
const results = [];
const logFile = new URL('../../.local/v2/logs/app.log', import.meta.url);

async function drill(id, name, expectation, inject) {
  if (only.length && !only.includes(id)) return;
  await resetFaults();
  await waitDrained(20000);
  const before = await counts();
  const report = await runPhase({...load, name: `${id} ${name}`, onStart: async ({startAt}) => {
    await sleep(Math.max(0, startAt + 10000 - Date.now()));     // 负载稳定 10 秒后注入故障
    return inject();
  }});
  await resetFaults();
  const drainedMs = await waitDrained(40000);
  const after = await counts();
  report.id = id;
  report.expectation = expectation;
  report.reconcile = reconcile(before, after, report);
  report.integrity = await integrity();
  report.auditDrainedMs = drainedMs;
  printPhase(report);
  const j = report.metrics.journey;
  console.log(`  旅程 成功 ${j.ok}/${j.requests}（${(j.successRate * 100).toFixed(2)}%） 注入：${JSON.stringify(report.side)}`);
  console.log(`  对账 ${report.reconcile.allMatch ? '全部一致' : '存在差异'}：` + report.reconcile.rows.map(r => `${r.item} ${r.client}/${r.database}`).join('；'));
  console.log(`  一致性检查 ${JSON.stringify(report.integrity)}`);
  results.push(report);
  await sleep(4000);
}
// 等到每个"被替换的进程"都以新的进程号重新出现在大盘里，返回耗时（毫秒）
async function waitReplaced(victims, timeoutMs = 20000) {
  const begin = Date.now();
  while (Date.now() - begin < timeoutMs) {
    try {
      const now = await apiInstances();
      if (victims.every(v => now.some(n => n.id === v.id && n.pid !== v.pid))) return Date.now() - begin;
    } catch { /* 重试 */ }
    await sleep(200);
  }
  return -1;
}

await drill('D1', '滚动重启（模拟发布）', '用户无感：旅程成功率 100%', async () => {
  const old = await apiInstances();
  signal(env.supervisor, 'SIGHUP');
  return {action: `SIGHUP 进程管理器，逐个替换 ${old.length} 个 API 进程`, allReplacedMs: await waitReplaced(old)};
});

await drill('D2', '强杀一个 API 进程', '在途请求由客户端重发；进程自动拉起', async () => {
  const instances = await apiInstances();
  const victim = instances[0];
  signal(victim.pid, 'SIGKILL');
  return {action: `SIGKILL ${victim.id}（pid ${victim.pid}）`, restartedMs: await waitReplaced([victim])};
});

await drill('D3', '强杀后台进程', '查询不受影响；审计留在事件流，进程拉起后补齐，不丢不重', async () => {
  const worker = (await overview()).instances.find(i => i.role === 'worker');
  signal(worker.pid, 'SIGKILL');
  const begin = Date.now();
  let restartedMs = -1;
  for (let i = 0; i < 60 && restartedMs < 0; i++) {
    await sleep(250);
    const now = (await overview()).instances.find(x => x.role === 'worker');
    if (now && now.pid !== worker.pid) restartedMs = Date.now() - begin;
  }
  return {action: `SIGKILL 后台进程（pid ${worker.pid}）`, restartedMs};
});

await drill('D4', 'Redis 假死 8 秒', '自动降级：本地限流 + 直连数据库 + 审计备用通道；审计不丢', async () => {
  signal(env.redis, 'SIGSTOP');
  await sleep(8000);
  signal(env.redis, 'SIGCONT');
  await sleep(3000);
  const o = await overview();
  return {action: 'SIGSTOP Redis 8 秒', limiterFallback: o.counters.limiter_fallback || 0, auditFallback: o.counters.audit_fallback || 0, forcedReconnect: o.counters.redis_forced_reconnect || 0};
});

await drill('D5', 'MySQL 停顿 8 秒', '快速失败并提示"暂不可用"，绝不返回"无记录"；恢复后自动继续', async () => {
  signal(env.mysql, 'SIGSTOP');
  await sleep(8000);
  signal(env.mysql, 'SIGCONT');
  await sleep(3000);
  const o = await overview();
  return {action: 'SIGSTOP MySQL 8 秒', breakerOpened: o.counters['breaker_opened|db'] || 0, breakerRejected: o.counters['breaker_rejected|db'] || 0};
});

await drill('D6', '核验供应商变慢（2–3 秒）持续 15 秒', '核验排队或提示稍后重试；已核验用户的其他操作不受影响', async () => {
  await fault({verify: {latencyMs: [2000, 3000]}});
  await sleep(15000);
  await fault({verify: {latencyMs: [120, 380]}});
  const o = await overview();
  return {action: '核验延迟调到 2–3 秒', breakerOpened: o.counters['breaker_opened|verify'] || 0, queueTimeout: o.counters['bulkhead_rejected|verify,wait_timeout'] || 0};
});

await drill('D7', '核验供应商宕机 10 秒', '断路器跳闸后立即提示稍后重试；恢复后自动闭合', async () => {
  await fault({verify: {down: true}});
  await sleep(10000);
  await fault({verify: {down: false}});
  const o = await overview();
  return {action: '核验接口直接断开连接', breakerOpened: o.counters['breaker_opened|verify'] || 0, breakerRejected: o.counters['breaker_rejected|verify'] || 0};
});

await drill('D8', '支付渠道宕机 10 秒', '下单提示稍后重试，查询与预约不受影响；恢复后可继续支付', async () => {
  await fault({pay: {down: true}});
  await sleep(10000);
  await fault({pay: {down: false}});
  const o = await overview();
  return {action: '支付接口直接断开连接', breakerOpened: o.counters['breaker_opened|pay'] || 0};
});

const log = await readFile(logFile, 'utf8').catch(() => '');
const out = process.env.REPORT || 'bench/reports/v2-drills.json';
await writeFile(out, JSON.stringify({date: new Date().toISOString(), target: 'V2', base,
  host: {cpu: 'Apple M4 · 10 核', mem: '16 GB', os: process.platform + ' ' + process.arch, node: process.version},
  load: {vus: load.vus, think: load.think, durationMs: load.durationMs, injectAtMs: 10000},
  unhandledErrorsInLog: (log.match(/"msg":"(unhandled error|uncaught exception)"/g) || []).length, drills: results}, null, 2) + '\n');
console.log('\n演练报告已写入 ' + out);
await closeDb();
