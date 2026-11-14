// 本人核验（F02）：姓名 + 证件号 → 供应商核验 → 签发"已核验"令牌。
// 这是全链路最慢、最贵、最容易被滥用的一步，因此保护最重：三重频率限制 + 每日预算 + 结果缓存 + 排队 + 断路。
import {createHash} from 'node:crypto';
import {config, demoMode} from '../config.mjs';
import {E, AppError} from '../errors.mjs';
import {normalizeId, normalizeName, isValidId, isValidName} from '../domain/idcard.mjs';
import {isSyntheticId} from '../domain/synth.mjs';
import {idHash, pairHash, subjectOf, proofKey, shortHash, maskName, maskId, mintToken} from '../infra/crypto.mjs';
import {take, refund} from '../infra/limiter.mjs';
import {redis, key} from '../infra/redis.mjs';
import {q} from '../infra/mysql.mjs';
import {nextId} from '../infra/ids.mjs';
import {inc} from '../infra/metrics.mjs';
import {checkIdentity} from '../providers/verify-provider.mjs';
import {bump, today} from './stats.mjs';

// 授权文本版本的短标签（写进授权记录的去重键：文本一改版本号就变，必须重新留痕）
const POLICY_TAG = createHash('sha256').update(config.policy.version).digest('base64url').slice(0, 10);

export async function verifyIdentity({claims, ip, name, idNo, consent}) {
  if (consent?.accepted !== true) throw E.consentRequired();
  if (consent.policyVersion !== config.policy.version) throw E.policyOutdated();
  const cleanName = normalizeName(name);
  const cleanId = normalizeId(idNo);
  if (!isValidName(cleanName)) throw E.nameFormat();
  if (!isValidId(cleanId)) throw E.idFormat();
  // Demo 环境的硬边界：只处理 99 开头的虚构证件号，真实证件号在这里就被拒绝，不会进入任何后续环节
  if (demoMode && !isSyntheticId(cleanId)) throw E.demoIdOnly();

  const identityHash = idHash(cleanId);
  const {limits} = config;
  // 第一层限流：同一会话、同一来源 IP 的核验频率（无论是否命中缓存都计数，防止脚本反复提交）
  const outerBuckets = [
    {key: 'verify:sid:' + claims.sid, ...limits.verifySid},
    {key: 'verify:ip:' + shortHash(ip), ...limits.verifyIp}
  ];
  const outer = await take(outerBuckets);
  if (!outer.allowed) { inc('verify_rate_limited', 'client'); throw E.rateLimited(null, {retryAfterMs: outer.retryAfterMs}); }
  const taken = [...outerBuckets];
  let budgetSpent = false;
  try {
    // 结果缓存：同一组"姓名 + 证件号"24 小时内不重复调用供应商（省钱、省时）；不一致的结果缓存 10 分钟，防止反复试探
    const cacheKey = key('vf', proofKey(cleanName, cleanId));
    let cached = null;
    try { cached = await redis.get(cacheKey); } catch { /* 缓存不可用时直接调用供应商 */ }
    let match;
    if (cached === '1' || cached === '0') {
      match = cached === '1';
      inc('verify_cache_hit');
    } else {
      // 第二层限流：只约束"真正要打到供应商的调用"。同一证件号每天最多 10 次——
      // 挡住"拿着一个证件号换着姓名试"的猜测，也封住单个证件被刷调用费的口子
      const idBucket = {key: 'verify:id:' + identityHash.subarray(0, 9).toString('base64url'), ...limits.verifyId};
      const inner = await take([idBucket]);
      if (!inner.allowed) { inc('verify_rate_limited', 'identity'); throw E.rateLimited(null, {retryAfterMs: inner.retryAfterMs}); }
      taken.push(idBucket);
      budgetSpent = await spendBudget();
      match = await checkIdentity(cleanName, cleanId);
      redis.set(cacheKey, match ? '1' : '0', 'EX', match ? config.verify.cacheOkSec : config.verify.cacheFailSec).catch(() => {});
    }
    if (!match) { bump('verify_fail', claims.ch); throw E.verifyMismatch(); }

    const sub = subjectOf(cleanId);
    // 授权记录同步落库：先留痕，再发放可以查询的令牌。去重键（会话 + 本人 + 文本版本）保证"超时后重试"不会写出两条
    await q('INSERT IGNORE INTO consents (id, sub, kind, policy_version, channel, dedup_key) VALUES (?,?,?,?,?,?)',
      [nextId(), sub, 'query', config.policy.version, claims.ch, `q:${claims.sid}:${sub}:${POLICY_TAG}`]);
    bump('verified', claims.ch);
    const profile = {nameMasked: maskName(cleanName), idMasked: maskId(cleanId)};
    const token = mintToken({
      sid: claims.sid, lvl: 1, ch: claims.ch, sub,
      ih: identityHash.toString('base64url'),
      ph: pairHash(cleanName, cleanId.slice(-4)).toString('base64url'),
      nm: profile.nameMasked, im: profile.idMasked
    }, config.session.verifiedTtlSec);
    return {token, profile, expiresInSec: config.session.verifiedTtlSec};
  } catch (error) {
    // 因为系统自身的原因没办成（供应商排队/故障、数据库不可用）：把刚才扣的频率额度和预算还给用户，
    // 否则前端按提示重试几次就会被自己的限流挡住。用户自身原因（姓名不符、超频）不退。
    if (!(error instanceof AppError) || error.status >= 500) {
      refund(taken);
      if (budgetSpent) redis.decr(key('vbudget', today())).catch(() => {});
    }
    throw error;
  }
}

// 每日核验预算（成本熔断）：核验按次计费，预算用尽后停止调用供应商，避免被刷接口造成不可控费用
async function spendBudget() {
  let used = 0;
  try {
    const budgetKey = key('vbudget', today());
    used = await redis.incr(budgetKey);
    if (used === 1) redis.expire(budgetKey, 172800).catch(() => {});
  } catch { return false; }       // Redis 不可用时不拦截（核验照常进行），预算由供应商侧配额兜底
  if (used > config.limits.verifyDailyBudget) {
    inc('verify_budget_exhausted');
    redis.decr(key('vbudget', today())).catch(() => {});
    throw new AppError('VERIFY_BUDGET_EXHAUSTED', 429, '今日核验额度已用完，请联系人工服务');
  }
  return true;
}
