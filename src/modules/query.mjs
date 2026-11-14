// 债权查询（F03/F04）。只能查"已核验的本人"——接口不接受任何姓名或证件号参数，身份完全来自令牌，
// 因此"遍历别人的姓名和尾号"在结构上不可能发生（旧版的公告候选检索接口可被 1 万次请求穷举）。
// 匹配顺序：有效授权台账 → 已核实历史转让 → 脱敏公告候选 → 无记录。数据库异常时返回"暂不可用"，绝不返回"无记录"。
import {config} from '../config.mjs';
import {E} from '../errors.mjs';
import {take} from '../infra/limiter.mjs';
import {redis, key} from '../infra/redis.mjs';
import {q} from '../infra/mysql.mjs';
import {nextId} from '../infra/ids.mjs';
import {inc} from '../infra/metrics.mjs';
import {dataVersion} from '../infra/flags.mjs';
import {recordQuery} from './audit.mjs';
import {bump} from './stats.mjs';

async function lookup(identityHash, pairKey) {
  const assets = await q(
    'SELECT holder, originator, loan_date, principal_fen, balance_fen, as_of FROM assets WHERE id_hash = ? AND mandate_status = 1 ORDER BY id LIMIT 30', [identityHash]);
  if (assets.length) {
    return {state: 'own', records: assets.map(a => ({
      holder: a.holder, originator: a.originator, loanDate: a.loan_date,
      principalFen: Number(a.principal_fen), balanceFen: Number(a.balance_fen), asOf: a.as_of
    }))};
  }
  const transfers = await q(
    'SELECT id, transfer_date, amount_fen FROM transfer_records WHERE id_hash = ? AND status = 1 ORDER BY transfer_date DESC, id LIMIT 30', [identityHash]);
  if (transfers.length) {
    return {state: 'history', transfers: transfers.map(t => ({recordId: t.id, transferDate: t.transfer_date, amountFen: Number(t.amount_fen)}))};
  }
  const candidates = await q('SELECT id FROM notice_candidates WHERE pair_hash = ? AND status = 1 LIMIT 2', [pairKey]);
  // 候选只是线索：无论 1 条还是多条都不展示明细；多条即"同名同尾号"，不任选其一
  if (candidates.length) return {state: 'candidate', ambiguous: candidates.length > 1};
  return {state: 'empty'};
}

export async function runQuery({claims, traceId}) {
  const {sub, ch} = claims;
  const limit = await take([{key: 'query:sub:' + sub, ...config.limits.querySub}]);
  if (!limit.allowed) { inc('query_rate_limited'); throw E.rateLimited(null, {retryAfterMs: limit.retryAfterMs}); }

  // 短时结果缓存：同一人 30 秒内重复查询（连点、刷新、重试风暴）不再打数据库
  const cacheKey = key('qr', dataVersion(), sub);
  const cacheOn = config.query.resultCacheSec > 0;      // 设为 0 可关闭（容量摸高测试时用，逼每次查询都打到数据库）
  let result = null, fromCache = false;
  if (cacheOn) {
    try {
      const raw = await redis.get(cacheKey);
      if (raw) { result = JSON.parse(raw); fromCache = true; inc('query_cache_hit'); }
    } catch { /* 缓存不可用，直接查库 */ }
  }
  if (!result) {
    result = await lookup(Buffer.from(claims.ih, 'base64url'), Buffer.from(claims.ph, 'base64url'));
    if (cacheOn) redis.set(cacheKey, JSON.stringify(result), 'EX', config.query.resultCacheSec).catch(() => {});
  }

  const queryId = nextId();
  const recordCount = result.records?.length ?? result.transfers?.length ?? 0;
  await recordQuery(
    {id: queryId, sub, outcome: result.state, recordCount, policy: config.policy.version, channel: ch, fromCache, traceId, at: Date.now()},
    {sub, outcome: result.state});
  bump('query', ch);
  bump('outcome_' + result.state, ch);

  if (result.state === 'history') {
    // 哪些记录已付费解锁（实时读取，不进缓存）
    const granted = new Set((await q('SELECT record_id FROM unlock_grants WHERE sub = ?', [sub])).map(r => r.record_id));
    result = {...result, transfers: result.transfers.map(t => ({...t, unlocked: granted.has(t.recordId)}))};
  }
  return {queryId, ...result, profile: {nameMasked: claims.nm, idMasked: claims.im}};
}
