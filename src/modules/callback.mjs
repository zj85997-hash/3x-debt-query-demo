// 人工回访预约（F06）。回访意愿与查询授权分开同意；同一次查询重复提交只生成一条预约；待处理的预约可撤回。
import {config} from '../config.mjs';
import {E} from '../errors.mjs';
import {take} from '../infra/limiter.mjs';
import {q, tx} from '../infra/mysql.mjs';
import {nextId, isId} from '../infra/ids.mjs';
import {flag} from '../infra/flags.mjs';
import {loadReceipt} from './audit.mjs';
import {bump} from './stats.mjs';

const view = t => ({id: t.id, queryId: t.query_id, timeWindow: t.time_window, status: t.status, createdAt: t.created_at});

export async function createCallback({claims, queryId, timeWindow, contactConsent}) {
  if (flag('callback_off')) throw E.featureDisabled('人工预约暂时关闭，请稍后再试');
  if (!isId(queryId)) throw E.badRequest('编号格式有误');
  if (!config.policy.callbackWindows.includes(timeWindow)) throw E.badRequest('请选择回访时段');
  if (contactConsent !== true) throw E.consentRequired('请单独确认是否同意回访');
  const {sub} = claims;
  const limit = await take([{key: 'write:sub:' + sub, ...config.limits.writeSub}]);
  if (!limit.allowed) throw E.rateLimited(null, {retryAfterMs: limit.retryAfterMs});
  const receipt = await loadReceipt(queryId);
  if (!receipt || receipt.sub !== sub) throw E.notFound('查询记录不可用，请重新查询');

  const id = nextId();
  try {
    await tx(async run => {
      await run('INSERT INTO callback_tickets (id, sub, query_id, time_window) VALUES (?,?,?,?)', [id, sub, queryId, timeWindow]);
      await run('INSERT INTO consents (id, sub, kind, policy_version, channel, ref_id, dedup_key) VALUES (?,?,?,?,?,?,?)', [nextId(), sub, 'contact', config.policy.version, claims.ch, id, 'c:' + id]);
    });
  } catch (error) {
    if (error.code !== 'ER_DUP_ENTRY') throw error;
    const [existing] = await q('SELECT id, query_id, time_window, status, created_at FROM callback_tickets WHERE query_id = ? AND sub = ?', [queryId, sub]);
    if (!existing) throw E.conflict('预约冲突，请重试');
    return {...view(existing), created: false};
  }
  bump('callback_created', claims.ch);
  return {id, queryId, timeWindow, status: 'pending', created: true};
}

export async function listCallbacks({claims}) {
  const rows = await q('SELECT id, query_id, time_window, status, created_at FROM callback_tickets WHERE sub = ? ORDER BY id DESC LIMIT 20', [claims.sub]);
  return {tickets: rows.map(view)};
}

export async function withdrawCallback({claims, id}) {
  if (!isId(id)) throw E.badRequest('预约编号无效');
  const changed = await tx(async run => {
    const result = await run("UPDATE callback_tickets SET status = 'withdrawn' WHERE id = ? AND sub = ? AND status = 'pending'", [id, claims.sub]);
    if (!result.affectedRows) return false;
    // 撤回即撤回联系授权：后续不得再据此联系用户
    await run("UPDATE consents SET withdrawn_at = NOW(3) WHERE ref_id = ? AND sub = ? AND kind = 'contact' AND withdrawn_at IS NULL", [id, claims.sub]);
    return true;
  });
  if (!changed) throw E.notFound('未找到可取消的预约');
  bump('callback_withdrawn', claims.ch);
  return {id, status: 'withdrawn'};
}
