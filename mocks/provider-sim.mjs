// 第三方服务模拟器（仅用于 Demo、压测与故障演练）：模拟"实名核验供应商"和"支付渠道"。
// 它故意表现得像真实的外部依赖：有延迟、有并发配额、会重复回调，还可以通过 /admin/fault 注入故障。
import http from 'node:http';
import {createHmac, randomBytes} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {indexOfId, nameOf} from '../src/domain/synth.mjs';

const port = Number(process.env.PROVIDER_PORT || 8810);
const notifySecret = process.env.PAY_NOTIFY_SECRET || '';
const state = {
  verify: {latencyMs: [120, 380], errorRate: 0, maxConcurrent: 400, down: false},
  pay: {latencyMs: [30, 90], notifyDelayMs: [80, 250], duplicateRate: 0.2, errorRate: 0, down: false}
};
const stats = {verifyCalls: 0, verifyRejected: 0, verifyPeak: 0, payCreates: 0, payConfirms: 0, notifySent: 0, notifyFailed: 0};
const orders = new Map();
let verifying = 0;
const between = ([min, max]) => min + Math.random() * (max - min);

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
const send = (res, status, body) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body)); };

async function notify(order, attempt = 0) {
  const rawBody = JSON.stringify({orderNo: order.orderNo, txnId: order.txnId, amountFen: order.amountFen, status: 'SUCCESS', paidAt: order.paidAt});
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', notifySecret).update(timestamp + '.' + rawBody).digest('hex');
  try {
    const response = await fetch(order.notifyUrl, {method: 'POST', body: rawBody, signal: AbortSignal.timeout(5000),
      headers: {'Content-Type': 'application/json', 'X-Pay-Timestamp': timestamp, 'X-Pay-Signature': signature}});
    await response.arrayBuffer();
    stats.notifySent++;
    if (response.ok || response.status === 409) return;
    throw new Error('notify status ' + response.status);
  } catch {
    stats.notifyFailed++;
    if (attempt < 5) { await sleep(500 * 2 ** attempt); return notify(order, attempt + 1); }   // 像真实渠道一样退避重试
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/admin/state') return send(res, 200, {state, stats, verifying});
    const body = req.method === 'POST' ? await readJson(req) : {};
    if (req.url === '/admin/fault') {
      for (const part of ['verify', 'pay']) Object.assign(state[part], body[part] || {});
      return send(res, 200, {state});
    }
    if (req.url === '/idverify') {
      const cfg = state.verify;
      if (cfg.down) return req.socket.destroy();
      if (verifying >= cfg.maxConcurrent) { stats.verifyRejected++; return send(res, 429, {code: 'QUOTA_EXCEEDED'}); }
      verifying++;
      stats.verifyCalls++;
      stats.verifyPeak = Math.max(stats.verifyPeak, verifying);
      try {
        await sleep(between(cfg.latencyMs));
        if (Math.random() < cfg.errorRate) return send(res, 500, {code: 'INTERNAL'});
        const index = indexOfId(String(body.idNo || ''));
        return send(res, 200, {match: index >= 0 && nameOf(index) === body.name});
      } finally { verifying--; }
    }
    if (req.url === '/pay/create') {
      const cfg = state.pay;
      if (cfg.down) return req.socket.destroy();
      await sleep(between(cfg.latencyMs));
      if (Math.random() < cfg.errorRate) return send(res, 500, {code: 'INTERNAL'});
      let order = orders.get(body.orderNo);
      if (!order) {
        order = {orderNo: String(body.orderNo), amountFen: body.amountFen, notifyUrl: body.notifyUrl, prepayId: 'PRE' + randomBytes(9).toString('hex'), txnId: null, paidAt: null};
        orders.set(order.orderNo, order);
        if (orders.size > 200000) orders.delete(orders.keys().next().value);
        stats.payCreates++;
      }
      return send(res, 200, {prepayId: order.prepayId});
    }
    if (req.url === '/pay/confirm') {
      const cfg = state.pay;
      if (cfg.down) return req.socket.destroy();
      const order = orders.get(String(body.orderNo));
      if (!order) return send(res, 404, {code: 'ORDER_NOT_FOUND'});
      if (!order.txnId) {
        order.txnId = 'TXN' + randomBytes(10).toString('hex');
        order.paidAt = new Date().toISOString();
        stats.payConfirms++;
        const copies = Math.random() < cfg.duplicateRate ? 2 : 1;     // 真实渠道会重复通知，用来检验回调幂等
        for (let i = 0; i < copies; i++) sleep(between(cfg.notifyDelayMs)).then(() => notify(order));
      }
      return send(res, 200, {accepted: true});
    }
    send(res, 404, {code: 'NOT_FOUND'});
  } catch (error) {
    if (!res.headersSent) send(res, 400, {code: 'BAD_REQUEST', message: error.message});
  }
});
server.keepAliveTimeout = 65000;
server.listen(port, '127.0.0.1', () => console.log('provider-sim listening on ' + port));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); setTimeout(() => process.exit(0), 300).unref(); });
