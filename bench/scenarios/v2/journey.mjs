// V2 · 完整用户旅程（验收主场景）：
// 进入页面 → 本人核验 → 查询 →（历史转让：下单 → 模拟支付 → 轮询订单 → 查看完整信息）→ 预约人工 → 查看预约 →（一半用户）撤回
import {getMeta, ipOf, pickPerson, step} from './common.mjs';

let meta;
export async function setup(vu) { meta = await getMeta(vu); }

export async function iteration(vu) {
  const round = vu.state.round = (vu.state.round ?? 0) + 1;
  const began = performance.now();
  const person = pickPerson(vu, round);
  const headers = {'X-Forwarded-For': ipOf(vu, round)};
  const fail = kind => vu.mark('journey', performance.now() - began, false, kind);

  const session = await step(vu, 'session', 'POST', '/api/v1/session', {body: {channel: 'bench'}, headers});
  if (!session) return fail('session');
  await vu.think();
  const verified = await step(vu, 'verify', 'POST', '/api/v1/verify', {token: session.token, headers,
    body: {name: person.name, idNo: person.idNo, consent: {policyVersion: meta.policy.version, accepted: true}}});
  if (!verified) return fail('verify');
  const token = verified.token;
  await vu.think();
  const result = await step(vu, 'query', 'POST', '/api/v1/query', {token, headers, body: {}});
  if (!result) return fail('query');
  if (result.state !== person.kind) return fail('wrong_state:' + person.kind + '->' + result.state);
  await vu.think();

  if (result.state === 'history') {
    const target = result.transfers[0];
    const idem = `bench-${vu.id}-${round}-${Date.now().toString(36)}`;
    const order = await step(vu, 'order.create', 'POST', '/api/v1/unlock/orders', {token, body: {queryId: result.queryId, recordId: target.recordId}, headers: {...headers, 'Idempotency-Key': idem}});
    if (!order) return fail('order.create');
    if (order.alreadyUnlocked) vu.mark('note:already_unlocked', 0, true);   // 抽到了之前压测已解锁过的人：不重复收费，直接看详情
    else {
      await vu.think();
      if (!await step(vu, 'order.pay', 'POST', `/api/v1/unlock/orders/${order.orderNo}/mock-pay`, {token, headers, body: {}})) return fail('order.pay');
      const payBegan = performance.now();
      let paid = false;
      for (let i = 0; i < 40 && !paid; i++) {       // 与前端一致：以服务端订单状态为准
        const status = await step(vu, 'order.status', 'GET', `/api/v1/unlock/orders/${order.orderNo}`, {token, headers});
        paid = status?.status === 'paid';
        if (!paid) await vu.sleep(250);
      }
      vu.mark('step:pay.confirmed', performance.now() - payBegan, paid, 'not_paid_in_10s');
      if (paid) vu.collect('paidOrders', order.orderNo);
      if (!paid) return fail('pay_not_confirmed');
    }
    const detail = await step(vu, 'record', 'GET', `/api/v1/records/${target.recordId}`, {token, headers});
    if (!detail?.contact) return fail('record');
    await vu.think();
  }

  const ticket = await step(vu, 'callback.create', 'POST', '/api/v1/callbacks', {token, headers,
    body: {queryId: result.queryId, timeWindow: meta.callbackWindows[round % 3], contactConsent: true}});
  if (!ticket) return fail('callback.create');
  const list = await step(vu, 'callback.list', 'GET', '/api/v1/callbacks', {token, headers});
  if (!list?.tickets.some(t => t.id === ticket.id)) return fail('callback.list');
  if (round % 2 === 0) {
    await vu.think();
    if (!await step(vu, 'callback.withdraw', 'POST', `/api/v1/callbacks/${ticket.id}/withdraw`, {token, headers, body: {}})) return fail('callback.withdraw');
  }
  vu.mark('journey', performance.now() - began, true);
}
