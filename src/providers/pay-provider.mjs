// 支付渠道适配层（Demo 对接模拟器；正式环境替换为微信支付 JSAPI 下单）。同样受舱壁与断路器保护。
import {config} from '../config.mjs';
import {E, BusyError, CircuitOpenError} from '../errors.mjs';
import {createClient} from '../infra/http-client.mjs';
import {Bulkhead} from '../infra/bulkhead.mjs';
import {Breaker} from '../infra/breaker.mjs';
import {inc} from '../infra/metrics.mjs';

const {pay} = config;
const client = createClient({baseUrl: pay.providerUrl, maxSockets: pay.concurrency, timeoutMs: pay.timeoutMs});
const gate = new Bulkhead({name: 'pay', maxConcurrent: pay.concurrency, maxQueue: 200, queueWaitMs: 2000});
const breaker = new Breaker({name: 'pay', windowSize: 20, minCalls: 10, failureRate: 0.5, openMs: 3000});

async function call(path, body) {
  try {
    return await gate.run(() => breaker.exec(async () => {
      const res = await client.post(path, body);
      if (res.status === 200 && res.body) return res.body;
      throw Object.assign(new Error('pay provider status ' + res.status), {code: 'PROVIDER_ERROR'});
    }));
  } catch (error) {
    if (!(error instanceof BusyError) && !(error instanceof CircuitOpenError)) inc('pay_provider_errors', error.code || 'UNKNOWN');
    throw E.payUnavailable(null, {retryAfterMs: 1000 + Math.round(Math.random() * 1500)});
  }
}
/** 预下单：同一订单号重复调用返回同一个预支付单（供应商侧幂等） */
export const createPrepay = (orderNo, amountFen) => call('/pay/create', {orderNo, amountFen, notifyUrl: pay.notifyUrl});
/** 仅 Demo：模拟用户在收银台完成支付，供应商随后异步回调 notifyUrl */
export const confirmMockPay = orderNo => call('/pay/confirm', {orderNo});
export const closePayProvider = () => client.close();
