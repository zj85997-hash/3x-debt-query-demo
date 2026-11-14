// 调用外部供应商（实名核验、支付）的 HTTP 客户端。
// 连接池要点：空闲连接数 = 并发上限，连接长期复用，杜绝"每次请求新建连接"造成的端口耗尽（旧版网关的崩溃根因）。
import http from 'node:http';
import https from 'node:https';

export function createClient({baseUrl, maxSockets, timeoutMs}) {
  const base = new URL(baseUrl);
  const lib = base.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({keepAlive: true, keepAliveMsecs: 15000, maxSockets, maxFreeSockets: maxSockets, scheduling: 'lifo'});

  function once(method, path, payload, headers) {
    return new Promise((resolve, reject) => {
      const req = lib.request({
        agent, host: base.hostname, port: base.port, method, path,
        headers: {...(payload ? {'Content-Type': 'application/json', 'Content-Length': payload.length} : {}), ...headers}
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('error', fail);
        res.on('end', () => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString();
          let body;
          try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
          resolve({status: res.statusCode, body});
        });
      });
      const timer = setTimeout(() => req.destroy(Object.assign(new Error('provider timeout'), {code: 'PROVIDER_TIMEOUT'})), timeoutMs);
      function fail(error) { clearTimeout(timer); error.reusedSocket = req.reusedSocket; reject(error); }
      req.on('error', fail);
      req.end(payload || undefined);
    });
  }
  return {
    /** 仅对幂等调用使用：复用的空闲连接恰好被对端关闭时，自动重试一次 */
    async post(path, body, headers = {}) {
      const payload = Buffer.from(JSON.stringify(body));
      try { return await once('POST', path, payload, headers); }
      catch (error) {
        if (error.reusedSocket && ['ECONNRESET', 'EPIPE'].includes(error.code)) return once('POST', path, payload, headers);
        throw error;
      }
    },
    close: () => agent.destroy()
  };
}
