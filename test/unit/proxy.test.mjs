import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {parseTrustProxy} from '../../src/config.mjs';

test('TRUST_PROXY 解析：默认不信任；拒绝"信任全部"；只接受 IP/网段或保留名', () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy('0'), false);
  assert.deepEqual(parseTrustProxy('100.64.0.0/10, 10.0.1.0/24'), ['100.64.0.0/10', '10.0.1.0/24']);
  assert.deepEqual(parseTrustProxy('loopback'), ['loopback']);
  assert.throws(() => parseTrustProxy('1'), /信任全部/);
  assert.throws(() => parseTrustProxy('true'), /信任全部/);
  assert.throws(() => parseTrustProxy('evil.example.com'), /格式不正确/);
});

test('用户在请求头里伪造的 X-Forwarded-For 不能冒充来源 IP', async () => {
  const ipOf = async (trustProxy, remoteAddress, xff) => {
    const app = Fastify({trustProxy});
    app.get('/', req => ({ip: req.ip}));
    const response = await app.inject({url: '/', remoteAddress, headers: xff ? {'x-forwarded-for': xff} : {}});
    await app.close();
    return response.json().ip;
  };
  const lb = parseTrustProxy('100.64.0.0/10');
  // 经过负载均衡：负载均衡把真实来源追加在最右侧，左侧是用户自己写的假值
  assert.equal(await ipOf(lb, '100.64.3.7', '6.6.6.6, 203.0.113.9'), '203.0.113.9');
  // 绕过负载均衡直连：请求头整个不可信，只认连接的对端地址
  assert.equal(await ipOf(lb, '198.51.100.20', '6.6.6.6'), '198.51.100.20');
  // 不配置代理：同样只认对端地址
  assert.equal(await ipOf(false, '198.51.100.20', '6.6.6.6'), '198.51.100.20');
});
