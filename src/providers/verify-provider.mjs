// 实名核验供应商适配层。真实环境替换为经批准的"姓名 + 证件号"二要素核验接口，本文件的保护逻辑不变：
//   舱壁：限制对供应商的并发（供应商有 QPS 配额），多出来的请求排队，最多等 3 秒；
//   断路器：供应商大面积出错时暂停调用 3 秒，直接告诉用户"稍后重试"，不让用户白等超时；
//   用户侧表现为"正在排队"（VERIFY_BUSY，带建议重试时间），前端自动重试——这就是排队机制。
import {config} from '../config.mjs';
import {E, BusyError, CircuitOpenError} from '../errors.mjs';
import {createClient} from '../infra/http-client.mjs';
import {Bulkhead} from '../infra/bulkhead.mjs';
import {Breaker} from '../infra/breaker.mjs';
import {inc, observe} from '../infra/metrics.mjs';

const {verify} = config;
const client = createClient({baseUrl: verify.providerUrl, maxSockets: verify.concurrency, timeoutMs: verify.timeoutMs});
const gate = new Bulkhead({name: 'verify', maxConcurrent: verify.concurrency, maxQueue: verify.queueMax, queueWaitMs: verify.queueWaitMs});
const breaker = new Breaker({name: 'verify', windowSize: 30, minCalls: 15, failureRate: 0.5, openMs: 3000});
const jitter = (base, spread) => Math.round(base + Math.random() * spread);

/** @returns {Promise<boolean>} 姓名与证件号是否一致 */
export async function checkIdentity(name, idNo) {
  const begin = performance.now();
  try {
    return await gate.run(() => breaker.exec(async () => {
      const res = await client.post('/idverify', {name, idNo});
      if (res.status === 200 && typeof res.body?.match === 'boolean') return res.body.match;
      throw Object.assign(new Error('verify provider status ' + res.status), {code: res.status === 429 ? 'PROVIDER_QUOTA' : 'PROVIDER_ERROR'});
    }));
  } catch (error) {
    if (error instanceof BusyError) throw E.verifyBusy(null, {retryAfterMs: jitter(800, 1200)});
    if (error instanceof CircuitOpenError) throw E.verifyUnavailable(null, {retryAfterMs: jitter(error.retryAfterMs, 1000)});
    inc('verify_provider_errors', error.code || 'UNKNOWN');
    throw E.verifyUnavailable(null, {retryAfterMs: jitter(1000, 1500)});
  } finally {
    observe('verify_provider_ms', '', performance.now() - begin);
  }
}
export const closeVerifyProvider = () => client.close();
