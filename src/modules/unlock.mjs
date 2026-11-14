// 付费解锁（F05）：历史转让记录的基础信息免费，完整 6 项信息（含受让方联系方式）¥9.90 解锁。
// 订单状态机：0 待支付 → 1 已支付（→ 3 已退款）；0 → 2 已关闭（超时）。
// 一致性要点：
//   · 下单幂等：客户端每次点击带一个幂等键，网络重试不会产生第二张订单；同一条记录的未支付订单会被复用。
//   · 回调幂等：支付渠道可能重复通知，"订单置为已支付 + 写入解锁授权"在同一个数据库事务里完成，重复通知直接返回成功。
//   · 以服务端为准：前端收到"支付成功"后仍要查询订单状态，只有数据库里是已支付才展示详情。
import {config, demoMode} from '../config.mjs';
import {E} from '../errors.mjs';
import {take} from '../infra/limiter.mjs';
import {q, tx} from '../infra/mysql.mjs';
import {nextId, isId} from '../infra/ids.mjs';
import {verifyNotify} from '../infra/crypto.mjs';
import {flag} from '../infra/flags.mjs';
import {inc} from '../infra/metrics.mjs';
import {log} from '../infra/logger.mjs';
import {createPrepay, confirmMockPay} from '../providers/pay-provider.mjs';
import {loadReceipt} from './audit.mjs';
import {bump} from './stats.mjs';

const STATUS = ['created', 'paid', 'closed', 'refunded'];
const view = o => ({orderNo: o.order_no, recordId: o.record_id, amountFen: Number(o.amount_fen), status: STATUS[o.status], createdAt: o.created_at, paidAt: o.paid_at, expireAt: o.expire_at});
const ORDER_COLUMNS = 'order_no, record_id, amount_fen, status, created_at, paid_at, expire_at';

export async function createOrder({claims, queryId, recordId, idemKey}) {
  if (flag('unlock_off')) throw E.featureDisabled('付费解锁暂时关闭，请稍后再试');
  if (!isId(queryId) || !isId(recordId)) throw E.badRequest('编号格式有误');
  if (typeof idemKey !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(idemKey)) throw E.badRequest('缺少幂等键 Idempotency-Key');
  const {sub} = claims;
  const limit = await take([{key: 'write:sub:' + sub, ...config.limits.writeSub}]);
  if (!limit.allowed) throw E.rateLimited(null, {retryAfterMs: limit.retryAfterMs});

  const receipt = await loadReceipt(queryId);
  if (!receipt || receipt.sub !== sub) throw E.notFound('查询记录不可用，请重新查询');
  if (receipt.outcome !== 'history') throw E.conflict('该查询结果没有可解锁的内容');
  // 归属校验以数据库为准：记录必须属于令牌里的本人，且仍处于已发布状态
  const [record] = await q('SELECT id FROM transfer_records WHERE id = ? AND id_hash = ? AND status = 1', [recordId, Buffer.from(claims.ih, 'base64url')]);
  if (!record) throw E.notFound('暂无可解锁的转让详情');
  const [grant] = await q('SELECT order_no FROM unlock_grants WHERE sub = ? AND record_id = ?', [sub, recordId]);
  if (grant) return {alreadyUnlocked: true, orderNo: grant.order_no, recordId};

  let [order] = await q(`SELECT ${ORDER_COLUMNS} FROM unlock_orders WHERE sub = ? AND record_id = ? AND status = 0 AND expire_at > NOW(3) ORDER BY order_no DESC LIMIT 1`, [sub, recordId]);
  if (!order) {
    const orderNo = nextId();
    try {
      await q('INSERT INTO unlock_orders (order_no, sub, record_id, query_id, amount_fen, channel, idem_key, expire_at) VALUES (?,?,?,?,?,?,?, DATE_ADD(NOW(3), INTERVAL ? SECOND))',
        [orderNo, sub, recordId, queryId, config.pay.priceFen, claims.ch, idemKey, config.pay.orderTtlSec]);
      bump('order_created', claims.ch);
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error;   // 同一幂等键的重复请求：返回第一次创建的订单
      inc('order_idempotent_hit');
    }
    [order] = await q(`SELECT ${ORDER_COLUMNS} FROM unlock_orders WHERE sub = ? AND idem_key = ?`, [sub, idemKey]);
    if (!order) throw E.conflict('订单创建冲突，请重试');
  }
  const prepay = await createPrepay(order.order_no, Number(order.amount_fen));
  return {...view(order), pay: {provider: 'mock', prepayId: prepay.prepayId}};
}

export async function getOrder({claims, orderNo}) {
  if (!isId(orderNo)) throw E.badRequest('订单号格式有误');
  const [order] = await q(`SELECT ${ORDER_COLUMNS} FROM unlock_orders WHERE order_no = ? AND sub = ?`, [orderNo, claims.sub]);
  if (!order) throw E.notFound('订单不存在');
  return view(order);
}

/** 仅 Demo：模拟用户在收银台付款。正式环境没有这个接口，由小程序调起微信支付。 */
export async function mockPay({claims, orderNo}) {
  if (!demoMode) throw E.notFound();
  const order = await getOrder({claims, orderNo});
  if (order.status === 'paid') return {accepted: true, status: 'paid'};
  if (order.status !== 'created') throw E.conflict('订单已关闭，请重新下单');
  await confirmMockPay(orderNo);
  return {accepted: true, status: 'processing'};
}

/** 支付渠道回调：验签 → 事务内改状态并发放解锁授权。重复通知幂等。 */
export async function handlePayNotify({rawBody, timestamp, signature}) {
  if (!verifyNotify(timestamp, rawBody, signature)) { inc('pay_notify_bad_signature'); throw E.forbidden('签名校验失败'); }
  let body;
  try { body = JSON.parse(rawBody); } catch { throw E.badRequest(); }
  const {orderNo, txnId, amountFen, status} = body;
  if (!isId(orderNo) || typeof txnId !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(txnId) || status !== 'SUCCESS') throw E.badRequest('回调内容有误');
  let channel = 'direct';
  const outcome = await tx(async run => {
    const [order] = await run('SELECT sub, record_id, amount_fen, status, channel FROM unlock_orders WHERE order_no = ? FOR UPDATE', [orderNo]);
    if (!order) return 'unknown_order';
    if (Number(order.amount_fen) !== amountFen) return 'amount_mismatch';
    if (order.status === 1) return 'duplicate';
    if (order.status === 3) return 'refunded';
    channel = order.channel;
    await run('UPDATE unlock_orders SET status = 1, paid_at = NOW(3), provider_txn = ? WHERE order_no = ?', [txnId, orderNo]);
    await run('INSERT IGNORE INTO unlock_grants (sub, record_id, order_no) VALUES (?,?,?)', [order.sub, order.record_id, orderNo]);
    return 'paid';
  });
  inc('pay_notify', outcome);
  if (outcome === 'paid') bump('order_paid', channel || 'direct');
  if (outcome === 'unknown_order' || outcome === 'amount_mismatch') {
    log.error({orderNo, outcome}, 'pay notify rejected');      // 需要人工对账
    throw E.conflict('订单与回调不一致');
  }
  return {ok: true, outcome};
}

/** 解锁后的完整信息（6 项）。必须有解锁授权，且记录属于本人、仍处于已发布状态。 */
export async function getRecord({claims, recordId}) {
  if (!isId(recordId)) throw E.badRequest('编号格式有误');
  const [row] = await q(
    `SELECT t.name_masked, t.id_masked, t.transferor, t.transferee, t.transfer_date, t.amount_fen, t.contact, t.notice_ref
       FROM unlock_grants g JOIN transfer_records t ON t.id = g.record_id
      WHERE g.sub = ? AND g.record_id = ? AND t.id_hash = ? AND t.status = 1`,
    [claims.sub, recordId, Buffer.from(claims.ih, 'base64url')]);
  if (!row) throw E.notFound('尚未解锁或记录已下架');
  return {recordId, debtor: row.name_masked + '　' + row.id_masked, transferor: row.transferor, transferee: row.transferee,
    transferDate: row.transfer_date, amountFen: Number(row.amount_fen), contact: row.contact, noticeRef: row.notice_ref};
}
