// 压测与演练共用的"环境操作"工具：读取本机环境信息、查库对账、向第三方模拟器注入故障、给进程发信号。
// 仅用于 npm run dev 启动的本机环境（信息来自 .local/v2/pids.json）。
import {readFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import mysql from 'mysql2/promise';

export const env = JSON.parse(await readFile(new URL('../../.local/v2/pids.json', import.meta.url), 'utf8').catch(() => { throw new Error('未找到本机环境，请先运行 npm run dev'); }));
export const base = process.env.BASE || env.base;

export async function overview() {
  const response = await fetch(base + '/ops/api/overview', {headers: {'X-Ops-Token': env.opsToken}, signal: AbortSignal.timeout(3000)});
  if (!response.ok) throw new Error('overview ' + response.status);
  return response.json();
}
export async function fault(patch) {
  await fetch(env.providerBase + '/admin/fault', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(patch)});
}
export const resetFaults = () => fault({verify: {latencyMs: [120, 380], errorRate: 0, down: false, maxConcurrent: 400}, pay: {latencyMs: [30, 90], errorRate: 0, down: false, duplicateRate: 0.2}});
export const providerState = async () => (await fetch(env.providerBase + '/admin/state')).json();

let connection;
const db = async () => connection ??= await mysql.createConnection({socketPath: env.mysqlSock, user: 'root', database: 'debt_query', supportBigNumbers: true});
export async function counts() {
  const [rows] = await (await db()).query(`SELECT
    (SELECT COUNT(*) FROM query_logs) AS queryLogs,
    (SELECT COUNT(*) FROM consents WHERE kind = 'query') AS queryConsents,
    (SELECT COUNT(*) FROM unlock_orders WHERE status = 1) AS paidOrders,
    (SELECT COUNT(*) FROM unlock_grants) AS grants,
    (SELECT COUNT(*) FROM callback_tickets) AS tickets,
    (SELECT COUNT(*) FROM callback_tickets WHERE status = 'withdrawn') AS withdrawn`);
  return Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));
}
/** 数据一致性的硬检查：有没有"已支付但没发放解锁"或"发放了但订单不是已支付"的记录 */
export async function integrity() {
  const [rows] = await (await db()).query(`SELECT
    (SELECT COUNT(*) FROM unlock_orders o LEFT JOIN unlock_grants g ON g.sub = o.sub AND g.record_id = o.record_id WHERE o.status = 1 AND g.sub IS NULL) AS paidWithoutGrant,
    (SELECT COUNT(*) FROM unlock_grants g LEFT JOIN unlock_orders o ON o.order_no = g.order_no AND o.status = 1 WHERE o.order_no IS NULL) AS grantWithoutPaidOrder,
    (SELECT COUNT(*) FROM (SELECT query_id FROM callback_tickets GROUP BY query_id HAVING COUNT(*) > 1) d) AS duplicateTickets,
    (SELECT COUNT(*) FROM (SELECT sub, record_id FROM unlock_orders WHERE status = 1 GROUP BY sub, record_id HAVING COUNT(*) > 1) d) AS doublePaid`);
  return Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));
}
export const closeDb = async () => { await connection?.end(); connection = null; };

/** 等待审计事件流清空（全部落库），最多等 timeoutMs */
export async function waitDrained(timeoutMs = 30000) {
  const begin = Date.now();
  while (Date.now() - begin < timeoutMs) {
    try {
      const o = await overview();
      const pending = o.instances.reduce((a, i) => a + (i.gauges.audit_fallback_pending || 0), 0);
      if (o.stream && o.stream.length === 0 && !o.stream.pending && pending === 0) return Date.now() - begin;
    } catch { /* 环境故障期间重试 */ }
    await sleep(300);
  }
  return -1;
}
/** 对账：把压测端看到的成功次数与数据库里的新增行数逐项比对 */
export function reconcile(before, after, report) {
  const ok = name => report.metrics[name]?.ok ?? 0;
  const rows = [
    ['查询成功 ↔ 审计行', ok('step:query'), after.queryLogs - before.queryLogs],
    ['核验成功 ↔ 授权记录', ok('step:verify'), after.queryConsents - before.queryConsents],
    // 按订单号去重：同一个人被两个虚拟用户同时抽到时，他们共用同一张订单（系统不会重复收费）
    ['支付确认（按订单去重）↔ 已支付订单', report.distinct?.paidOrders ?? 0, after.paidOrders - before.paidOrders],
    ['支付确认（按订单去重）↔ 解锁授权', report.distinct?.paidOrders ?? 0, after.grants - before.grants],
    ['预约创建 ↔ 预约单', ok('step:callback.create'), after.tickets - before.tickets],
    ['预约撤回 ↔ 已撤回', ok('step:callback.withdraw'), after.withdrawn - before.withdrawn]
  ].map(([item, client, database]) => ({item, client, database, match: client === database}));
  return {rows, allMatch: rows.every(r => r.match)};
}
export const signal = (pid, sig) => { try { process.kill(pid, sig); return true; } catch { return false; } };
export const apiInstances = async () => (await overview()).instances.filter(i => i.role === 'api');
export {sleep};
