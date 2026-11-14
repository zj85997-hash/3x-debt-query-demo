// 前端接口客户端。两件事值得注意：
//  1. 服务端说"忙"（503 + 建议等待时间）时，这里按建议时间自动重试并把"正在排队"告诉界面——用户看到的是排队，而不是报错；
//  2. 只有幂等的请求才会自动重试：下单带幂等键，预约按查询编号去重，核验与查询本身可重复。
const listeners = new Set();
export const onCall = listener => listeners.add(listener);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const RETRYABLE = new Set(['VERIFY_BUSY', 'VERIFY_UNAVAILABLE', 'SERVER_BUSY', 'QUERY_UNAVAILABLE', 'PAY_UNAVAILABLE']);

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || (status ? '服务暂时不可用，请稍后重试' : '网络连接失败，请检查网络后重试'));
    this.status = status;
    this.code = body?.code || (status ? 'HTTP_' + status : 'NETWORK');
    this.retryAfterMs = body?.retryAfterMs || 0;
    this.traceId = body?.traceId || '';
  }
}

let anonymous = null;   // 匿名会话令牌
let verified = null;    // 已核验令牌（只放内存，刷新页面即失效）

async function once(method, path, body, token, headers) {
  const begin = performance.now();
  let status = 0, json = null, instance = '', traceId = '';
  try {
    const response = await fetch(path, {
      method,
      headers: {...(body !== undefined ? {'Content-Type': 'application/json'} : {}), ...(token ? {Authorization: 'Bearer ' + token} : {}), ...headers},
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    status = response.status;
    instance = response.headers.get('x-instance') || '';
    traceId = response.headers.get('x-request-id') || '';
    json = await response.json().catch(() => null);
  } catch { /* 网络错误：status 保持 0 */ }
  const call = {method, path, status, ms: Math.round(performance.now() - begin), instance, traceId, code: json?.code || ''};
  for (const listener of listeners) listener(call);
  if (status >= 200 && status < 300) return json;
  throw new ApiError(status, json);
}

async function request(method, path, body, {token, headers = {}, retries = 6, onWait} = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await once(method, path, body, token, headers); }
    catch (error) {
      const retryable = error.status === 0 || (error.status === 503 && RETRYABLE.has(error.code));
      if (!retryable || attempt > retries) throw error;
      const waitMs = Math.min(8000, (error.retryAfterMs || 700) * (1 + (attempt - 1) * 0.4)) + Math.random() * 300;
      onWait?.({attempt, waitMs, code: error.code});
      await sleep(waitMs);
    }
  }
}

export const getMeta = () => request('GET', '/api/v1/meta');
export async function verify({name, idNo, policyVersion, channel, onWait}) {
  if (!anonymous) anonymous = (await request('POST', '/api/v1/session', {channel: channel || ''}, {onWait})).token;
  try {
    const result = await request('POST', '/api/v1/verify', {name, idNo, consent: {policyVersion, accepted: true}}, {token: anonymous, onWait});
    verified = result.token;
    return result.profile;
  } catch (error) {
    if (error.status === 401) anonymous = null;   // 匿名会话过期：下次重新领取
    throw error;
  }
}
const authed = (method, path, body, options = {}) => {
  if (!verified) throw new ApiError(401, {code: 'VERIFY_REQUIRED', message: '请先完成本人核验'});
  return request(method, path, body, {...options, token: verified});
};
export const query = onWait => authed('POST', '/api/v1/query', {}, {onWait});
export const createOrder = (queryId, recordId, idemKey) => authed('POST', '/api/v1/unlock/orders', {queryId, recordId}, {headers: {'Idempotency-Key': idemKey}});
export const mockPay = orderNo => authed('POST', `/api/v1/unlock/orders/${orderNo}/mock-pay`, {});
export const getOrder = orderNo => authed('GET', `/api/v1/unlock/orders/${orderNo}`);
export const getRecord = recordId => authed('GET', `/api/v1/records/${recordId}`);
export const createCallback = (queryId, timeWindow) => authed('POST', '/api/v1/callbacks', {queryId, timeWindow, contactConsent: true});
export const listCallbacks = () => authed('GET', '/api/v1/callbacks');
export const withdrawCallback = id => authed('POST', `/api/v1/callbacks/${id}/withdraw`, {});
export const logout = () => { verified = null; anonymous = null; };
export const isVerified = () => !!verified;
