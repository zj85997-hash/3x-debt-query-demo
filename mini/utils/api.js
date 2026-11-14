// 小程序端接口客户端：与 H5 的 web/api.js 同一套约定——
// 服务端回"忙"（503 + 建议等待时间）时自动等待重试，并通过 onWait 让页面显示"正在排队"。
const {baseUrl} = require('../config');
const RETRYABLE = ['VERIFY_BUSY', 'VERIFY_UNAVAILABLE', 'SERVER_BUSY', 'QUERY_UNAVAILABLE', 'PAY_UNAVAILABLE'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function once(method, path, data, token, header) {
  return new Promise(resolve => wx.request({
    url: baseUrl + path, method, data, timeout: 10000,
    header: Object.assign({'content-type': 'application/json'}, token ? {Authorization: 'Bearer ' + token} : {}, header || {}),
    success: res => resolve({status: res.statusCode, body: res.data || {}}),
    fail: () => resolve({status: 0, body: {}})
  }));
}
async function request(method, path, data, options) {
  const {token, header, onWait, retries = 6} = options || {};
  for (let attempt = 1; ; attempt++) {
    const res = await once(method, path, data, token, header);
    if (res.status >= 200 && res.status < 300) return res.body;
    const retryable = res.status === 0 || (res.status === 503 && RETRYABLE.indexOf(res.body.code) >= 0);
    if (!retryable || attempt > retries) {
      const error = new Error(res.body.message || (res.status ? '服务暂时不可用，请稍后重试' : '网络连接失败，请检查网络'));
      error.status = res.status;
      error.code = res.body.code || '';
      error.retryAfterMs = res.body.retryAfterMs || 0;
      throw error;
    }
    const waitMs = Math.min(8000, (res.body.retryAfterMs || 700) * (1 + (attempt - 1) * 0.4)) + Math.random() * 300;
    if (onWait) onWait({attempt, code: res.body.code});
    await sleep(waitMs);
  }
}
const uuid = () => 'mp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);

module.exports = {
  getMeta: () => request('GET', '/api/v1/meta'),
  openSession: (channel, onWait) => request('POST', '/api/v1/session', {channel: channel || ''}, {onWait}),
  verify: (session, name, idNo, policyVersion, onWait) => request('POST', '/api/v1/verify', {name, idNo, consent: {policyVersion, accepted: true}}, {token: session, onWait}),
  query: (token, onWait) => request('POST', '/api/v1/query', {}, {token, onWait}),
  createOrder: (token, queryId, recordId) => request('POST', '/api/v1/unlock/orders', {queryId, recordId}, {token, header: {'Idempotency-Key': uuid()}}),
  mockPay: (token, orderNo) => request('POST', '/api/v1/unlock/orders/' + orderNo + '/mock-pay', {}, {token}),
  getOrder: (token, orderNo) => request('GET', '/api/v1/unlock/orders/' + orderNo, undefined, {token}),
  getRecord: (token, recordId) => request('GET', '/api/v1/records/' + recordId, undefined, {token}),
  createCallback: (token, queryId, timeWindow) => request('POST', '/api/v1/callbacks', {queryId, timeWindow, contactConsent: true}, {token}),
  listCallbacks: token => request('GET', '/api/v1/callbacks', undefined, {token}),
  withdrawCallback: (token, id) => request('POST', '/api/v1/callbacks/' + id + '/withdraw', {}, {token}),
  sleep
};
