// 压测引擎 · 虚拟用户线程
// 每个线程承载一批虚拟用户（VU）。线程之间互不共享事件循环，避免压测端自身成为瓶颈。
import {parentPort, workerData} from 'node:worker_threads';
import http from 'node:http';
import https from 'node:https';
import {performance} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';

const {scenario, base, vuStart, vuCount, vuTotal, durationMs, mode, think, rampMs, params, timeoutMs} = workerData;
const target = new URL(base);
const lib = target.protocol === 'https:' ? https : http;
const agent = new lib.Agent({keepAlive: true, maxSockets: Infinity, maxFreeSockets: 4096});

class Series {
  constructor() {
    this.lat = new Float32Array(4096);
    this.n = 0;
    this.requests = 0;
    this.soft = 0;
    this.status = Object.create(null);
    this.failKinds = Object.create(null);
  }
  ok(ms) {
    if (this.n === this.lat.length) {
      const grown = new Float32Array(this.lat.length * 2);
      grown.set(this.lat);
      this.lat = grown;
    }
    this.lat[this.n++] = ms;
  }
}
const collected = new Map();   // 需要跨线程去重统计的值（例如已确认支付的订单号）
const series = new Map();
const seriesOf = name => {
  let s = series.get(name);
  if (!s) series.set(name, s = new Series());
  return s;
};
const TL = 4000;
const tlOk = new Uint32Array(TL);
const tlFail = new Uint32Array(TL);
let inFlight = 0;
let startAt = 0;

let staleRetries = 0;
function sendOnce(method, path, payload, headers) {
  return new Promise(resolve => {
    const req = lib.request({
      agent, host: target.hostname, port: target.port, method, path, timeout: timeoutMs,
      headers: {
        ...(payload ? {'Content-Type': 'application/json', 'Content-Length': payload.length} : {}),
        ...headers
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', e => resolve({status: 0, error: e.code || 'RES_ERROR', headers: {}}));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json;
        try { json = text ? JSON.parse(text) : undefined; } catch { /* 非 JSON 响应 */ }
        resolve({status: res.statusCode, headers: res.headers, body: json, text});
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), {code: 'CLIENT_TIMEOUT'})));
    req.on('error', e => resolve({status: 0, error: e.code || 'REQ_ERROR', headers: {}, stale: req.reusedSocket && ['ECONNRESET', 'EPIPE'].includes(e.code)}));
    if (payload) req.end(payload); else req.end();
  });
}
// 与浏览器、负载均衡的标准行为一致：复用的空闲长连接恰好被对端关闭（尚未收到任何响应）时，换一条新连接重发一次。
// 重发次数单独计数（_stale_conn_retry），不会掩盖真正的服务端错误。
async function rawRequest(method, path, body, headers) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const first = await sendOnce(method, path, payload, headers);
  if (!first.stale) return first;
  staleRetries++;
  return sendOnce(method, path, payload, headers);
}

function makeVu(id) {
  const vu = {
    id, state: {}, params, total: vuTotal,
    sleep,
    think: (min = think[0], max = think[1]) => (max > 0 ? sleep(min + Math.random() * (max - min)) : undefined),
    // metric: 指标名；ok: 成功判定（默认 2xx）；soft: "预期内的拒绝"判定（排队、限流等），既不算成功也不算失败
    async request(metric, method, path, {body, token, headers, ok, soft, tag} = {}) {
      const s = seriesOf(metric);
      const begin = performance.now();
      inFlight++;
      s.requests++;
      const res = await rawRequest(method, path, body, {...(token ? {Authorization: 'Bearer ' + token} : {}), ...headers});
      inFlight--;
      const ms = performance.now() - begin;
      const key = res.status || res.error;
      s.status[key] = (s.status[key] || 0) + 1;
      const good = ok ? ok(res) : res.status >= 200 && res.status < 300;
      const sec = startAt ? Math.min(TL - 1, Math.max(0, Math.floor((Date.now() - startAt) / 1000))) : 0;
      if (good) { s.ok(ms); tlOk[sec]++; }
      else if (soft && soft(res)) { s.soft++; res.soft = true; }
      else {
        const kind = (res.status ? res.status + ':' + (res.body?.code ?? res.body?.state ?? '') : res.error) + (tag ? '@' + tag(res) : '');
        s.failKinds[kind] = (s.failKinds[kind] || 0) + 1;
        tlFail[sec]++;
      }
      res.ok = good;
      res.ms = ms;
      return res;
    },
    // 收集一个需要"去重后计数"的值（同一个人可能被两个虚拟用户同时抽到，他们会共用同一张订单）
    collect(name, value) {
      let set = collected.get(name);
      if (!set) collected.set(name, set = new Set());
      set.add(value);
    },
    // 记录一个业务层面的结果（例如"整段旅程"或"含排队重试的一步"），不对应单次 HTTP 请求
    mark(metric, ms, ok = true, kind = 'failed') {
      const s = seriesOf(metric);
      s.requests++;
      if (ok) s.ok(ms); else s.failKinds[kind] = (s.failKinds[kind] || 0) + 1;
    }
  };
  return vu;
}

const mod = await import(scenario);
const vus = Array.from({length: vuCount}, (_, i) => makeVu(vuStart + i));
// 预置阶段（不计入正式指标）：例如预先创建会话
if (mod.setup) {
  for (let i = 0; i < vus.length; i += 50) await Promise.all(vus.slice(i, i + 50).map(vu => mod.setup(vu)));
  for (const s of series.values()) { s.n = 0; s.requests = 0; s.soft = 0; s.status = Object.create(null); s.failKinds = Object.create(null); }
  tlOk.fill(0); tlFail.fill(0);
}
parentPort.postMessage({type: 'ready'});
startAt = await new Promise(resolve => parentPort.once('message', m => resolve(m.startAt)));
const ticker = setInterval(() => parentPort.postMessage({type: 'inflight', v: inFlight}), 100);
await sleep(Math.max(0, startAt - Date.now()));
const deadline = startAt + durationMs;

await Promise.all(vus.map(async vu => {
  if (mode === 'once') { await mod.iteration(vu).catch(noteCrash); return; }
  if (rampMs) await sleep(rampMs * (vu.id / vuTotal));
  while (Date.now() < deadline) {
    await mod.iteration(vu).catch(noteCrash);
    if (think[1] > 0) {
      const wait = think[0] + Math.random() * (think[1] - think[0]);
      if (Date.now() + wait >= deadline) break;
      await sleep(wait);
    }
  }
}));
function noteCrash(error) {
  const s = seriesOf('_scenario_error');
  s.requests++;
  s.failKinds[error.message] = (s.failKinds[error.message] || 0) + 1;
}

clearInterval(ticker);
if (staleRetries) { const s = seriesOf('_stale_conn_retry'); s.requests = staleRetries; s.soft = staleRetries; }
const out = {};
const transfer = [];
for (const [name, s] of series) {
  const lat = s.lat.slice(0, s.n);
  out[name] = {lat, requests: s.requests, soft: s.soft, status: s.status, failKinds: s.failKinds};
  transfer.push(lat.buffer);
}
parentPort.postMessage({type: 'done', series: out, tlOk, tlFail, collected: Object.fromEntries([...collected].map(([k, v]) => [k, [...v]]))}, transfer);
agent.destroy();
