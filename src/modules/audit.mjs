// 查询审计。原则：审计一条都不能丢，但不能让"写审计"拖慢或拖垮查询。
//   主通道：查询回执 + 审计事件一次性写入 Redis（事件流），由后台进程批量落库（500 条一个事务）。
//   备通道：Redis 不可用或事件流积压过大时，改为本进程暂存并直接批量写库。
//   兜底：  暂存也满了 → 拒绝新查询（宁可暂停服务，也不产生没有审计的查询）。
//   对账：  每条查询同时输出一行 audit 日志，可与数据库逐条核对。
import {config} from '../config.mjs';
import {E} from '../errors.mjs';
import {redis, key, redisReady} from '../infra/redis.mjs';
import {bulk, q} from '../infra/mysql.mjs';
import {log} from '../infra/logger.mjs';
import {gauge, inc} from '../infra/metrics.mjs';

export const STREAM = key('ev');
export const GROUP = 'persist';
const fmt = ms => new Date(ms + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 23);

/** 批量写入审计表。主键是查询编号，INSERT IGNORE 保证重复投递不会产生重复行（至少一次投递 + 幂等写入） */
export function insertQueryLogs(entries) {
  if (!entries.length) return Promise.resolve();
  return bulk('INSERT IGNORE INTO query_logs (id, sub, outcome, record_count, policy_version, channel, from_cache, trace_id, created_at) VALUES ?',
    entries.map(e => [e.id, e.sub, e.outcome, e.recordCount, e.policy, e.channel, e.fromCache ? 1 : 0, e.traceId, fmt(e.at)]));
}

const pending = [];           // 备通道暂存
let streamBacklog = 0;        // 由 ops 快照循环更新的事件流长度
let flushing = false;
export const setStreamBacklog = n => { streamBacklog = n; };
gauge('audit_fallback_pending', () => pending.length);

async function flushPending() {
  if (flushing || !pending.length) return;
  flushing = true;
  const batch = pending.splice(0, 1000);
  try { await insertQueryLogs(batch); inc('audit_fallback_flushed', '', batch.length); }
  catch { pending.unshift(...batch); }
  finally { flushing = false; }
}
const timer = setInterval(flushPending, 250);
timer.unref();
export async function drainAudit() { clearInterval(timer); for (let i = 0; i < 40 && pending.length; i++) { await flushPending(); if (pending.length) await new Promise(r => setTimeout(r, 250)); } }

/**
 * 记录一次查询。
 * @param entry   审计内容 {id, sub, outcome, recordCount, policy, channel, fromCache, traceId, at}
 * @param receipt 回执（后续解锁、预约据此确认"这次查询确实是该用户发起的"）
 */
export async function recordQuery(entry, receipt) {
  log.audit({kind: 'query', id: entry.id, sub: entry.sub, outcome: entry.outcome, trace: entry.traceId});
  if (redisReady() && streamBacklog < config.events.maxLen) {
    try {
      const results = await redis.pipeline()
        .set(key('q', entry.id), JSON.stringify(receipt), 'EX', config.query.receiptTtlSec)
        .xadd(STREAM, '*', 'd', JSON.stringify(entry))
        .exec();
      if (!results[1][0]) return;                    // 事件已进入事件流
    } catch { /* 走备通道 */ }
  }
  inc('audit_fallback');
  if (pending.length >= config.events.fallbackMax) throw E.queryUnavailable();
  pending.push({...entry, receipt});
}

/** 读取查询回执：先 Redis，再本进程暂存，最后查数据库 */
export async function loadReceipt(queryId) {
  try {
    const raw = await redis.get(key('q', queryId));
    if (raw) return JSON.parse(raw);
  } catch { /* 降级读库 */ }
  const local = pending.find(e => e.id === queryId);
  if (local) return local.receipt;
  const [row] = await q('SELECT sub, outcome FROM query_logs WHERE id = ?', [queryId]);
  return row ? {sub: row.sub, outcome: row.outcome} : null;
}
