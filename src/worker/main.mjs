// 后台进程（异步层）：把"可以稍后做"的工作从用户请求里拿出来，与在线查询互不影响（轻重分离）。
//   1. 消费事件流，把查询审计批量写入数据库（至少一次投递 + 主键幂等 = 不丢不重）
//   2. 每 5 秒把实时统计同步到 stat_daily
//   3. 每 30 秒关闭超时未支付的订单
import {setTimeout as sleep} from 'node:timers/promises';
import {config} from '../config.mjs';
import {log, instanceId} from '../infra/logger.mjs';
import {redis, key, createBlockingClient} from '../infra/redis.mjs';
import {pool, q, bulk} from '../infra/mysql.mjs';
import {inc, gauge, observe} from '../infra/metrics.mjs';
import {STREAM, GROUP, insertQueryLogs} from '../modules/audit.mjs';
import {startSnapshots, stopSnapshots} from '../modules/ops.mjs';
import {today} from '../modules/stats.mjs';

let stopping = false;
let persisted = 0;
gauge('worker_persisted', () => persisted);
const reader = createBlockingClient();

async function ensureGroup() {
  for (;;) {
    try { await redis.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM'); return; }
    catch (error) {
      if (String(error.message).includes('BUSYGROUP')) return;
      if (stopping) return;
      await sleep(1000);
    }
  }
}
// 把一批事件写库；数据库不可用时原地重试，不确认、不丢弃（事件仍安全地留在事件流里）
async function persist(entries) {
  if (!entries.length) return;
  const rows = [];
  const ids = [];
  for (const [id, fields] of entries) {
    ids.push(id);
    try { rows.push(JSON.parse(fields[1])); } catch { log.error({id}, 'bad event payload'); }
  }
  const begin = performance.now();
  for (let attempt = 0; ; attempt++) {
    try { await insertQueryLogs(rows); break; }
    catch (error) {
      inc('worker_persist_retry');
      if (attempt % 10 === 0) log.warn({code: error.code || error.name, attempt}, 'persist failed, retrying');
      if (stopping && attempt > 5) return;
      await sleep(Math.min(200 * (attempt + 1), 2000));
    }
  }
  // 已落库：确认并从事件流删除，事件流里只保留"尚未落库"的部分
  await redis.pipeline().xack(STREAM, GROUP, ...ids).xdel(STREAM, ...ids).exec().catch(() => {});
  persisted += rows.length;
  inc('worker_batches');
  observe('worker_batch_ms', '', performance.now() - begin);
}
async function consume() {
  await ensureGroup();
  let cursor = '0';      // 先处理本消费者上次未确认的事件（例如进程被强杀前读到但没写完的）
  while (!stopping) {
    try {
      const reply = await reader.xreadgroup('GROUP', GROUP, instanceId, 'COUNT', config.events.batchSize, 'BLOCK', 1000, 'STREAMS', STREAM, cursor);
      const entries = reply?.[0]?.[1] || [];
      if (cursor === '0' && !entries.length) { cursor = '>'; continue; }
      await persist(entries);
    } catch (error) {
      if (stopping) break;
      if (String(error.message).includes('NOGROUP')) await ensureGroup();
      else await sleep(500);
    }
  }
}
// 接管其他消费者遗留超过 30 秒未确认的事件（消费者进程异常退出时的补偿）
async function reclaim() {
  try {
    const [, entries] = await redis.xautoclaim(STREAM, GROUP, instanceId, 30000, '0', 'COUNT', config.events.batchSize);
    if (entries?.length) { inc('worker_reclaimed', '', entries.length); await persist(entries); }
  } catch { /* 下一轮再试 */ }
}
async function syncStats() {
  try {
    const day = today();
    const raw = await redis.hgetall(key('stat', day));
    const rows = Object.entries(raw).map(([field, value]) => { const [channel, metric] = field.split('|'); return [day, channel, metric, Number(value)]; });
    if (rows.length) await bulk('INSERT INTO stat_daily (stat_date, channel, metric, value) VALUES ? ON DUPLICATE KEY UPDATE value = VALUES(value)', rows);
    await redis.pipeline().expire(key('stat', day), 8 * 86400).zremrangebyscore(key('m:alive'), 0, Date.now() - 60000).exec();
  } catch { /* 统计属于可丢弃的非关键任务 */ }
}
async function closeExpiredOrders() {
  try {
    const result = await q('UPDATE unlock_orders SET status = 2 WHERE status = 0 AND expire_at < NOW(3) LIMIT 500');
    if (result.affectedRows) inc('orders_expired', '', result.affectedRows);
  } catch { /* 下一轮再试 */ }
}

startSnapshots('worker');
const timers = [setInterval(reclaim, 15000), setInterval(syncStats, 5000), setInterval(closeExpiredOrders, 30000)];
log.info({}, 'worker ready');
process.send?.({type: 'ready'});
const consuming = consume();

async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log.info({reason}, 'worker stopping');
  setTimeout(() => process.exit(1), 10000).unref();
  timers.forEach(clearInterval);
  await consuming.catch(() => {});
  await syncStats();
  stopSnapshots();
  reader.disconnect();
  await pool.end().catch(() => {});
  redis.disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('disconnect', () => shutdown('supervisor gone'));   // 进程管理器不在了，自己也退出，避免成为孤儿进程
process.on('uncaughtException', error => { log.error({err: error}, 'uncaught exception'); shutdown('uncaughtException'); });
