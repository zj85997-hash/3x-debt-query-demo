// 逻辑层 · HTTP 应用装配：路由表 + 四道统一关卡（准入 → 鉴权 → 参数校验 → 错误映射）。
// 业务规则全部在 src/modules/ 里；这里只做协议转换，不写业务判断。
import Fastify from 'fastify';
import {timingSafeEqual} from 'node:crypto';
import {config} from '../config.mjs';
import {AppError, E, BusyError, CircuitOpenError} from '../errors.mjs';
import {readToken, randomId} from '../infra/crypto.mjs';
import {inc, observe, gauge} from '../infra/metrics.mjs';
import {log, instanceId} from '../infra/logger.mjs';
import {flag, setFlag, FLAG_NAMES} from '../infra/flags.mjs';
import {isInfraFailure, dbState, dbSaturated} from '../infra/mysql.mjs';
import {redisReady} from '../infra/redis.mjs';
import {openSession} from '../modules/session.mjs';
import {verifyIdentity} from '../modules/verify.mjs';
import {runQuery} from '../modules/query.mjs';
import {createOrder, getOrder, mockPay, handlePayNotify, getRecord} from '../modules/unlock.mjs';
import {createCallback, listCallbacks, withdrawCallback} from '../modules/callback.mjs';
import {getMeta} from '../modules/meta.mjs';
import {overview, prometheusText} from '../modules/ops.mjs';
import {touch} from '../modules/presence.mjs';
import {sendAsset} from './static.mjs';

const {overload, security} = config;
const opsToken = Buffer.from(security.opsToken);
const isOps = value => typeof value === 'string' && value.length === opsToken.length && timingSafeEqual(Buffer.from(value), opsToken);

export function buildApp(state) {
  const app = Fastify({
    logger: false,
    trustProxy: config.app.trustProxy,
    bodyLimit: 16 * 1024,
    keepAliveTimeout: 65000,        // 必须大于负载均衡的空闲超时（阿里云 ALB 默认 60 秒以内），避免复用到已被关闭的连接
    requestTimeout: 15000,
    requestIdHeader: false,
    genReqId: req => {
      const inbound = req.headers['x-request-id'];
      return typeof inbound === 'string' && /^[\w-]{6,64}$/.test(inbound) ? inbound : randomId(9);
    },
    ajv: {customOptions: {coerceTypes: false, removeAdditional: false}}
  });

  // 保留原始报文（支付回调验签需要逐字节一致）
  app.addContentTypeParser('application/json', {parseAs: 'string'}, (req, body, done) => {
    req.rawBody = body;
    if (body === '') return done(null, undefined);
    try { done(null, JSON.parse(body)); } catch { done(E.badRequest('请求内容不是合法的 JSON')); }
  });

  // ── 过载保护：在途请求数 + 事件循环延迟 两个信号，任何一个超限就"及早拒绝"
  let inFlight = 0;
  let lagMs = 0;
  let expected = performance.now() + 100;
  const lagTimer = setInterval(() => {
    const now = performance.now();
    lagMs = lagMs * 0.6 + Math.max(0, now - expected) * 0.4;
    expected = now + 100;
  }, 100);
  lagTimer.unref();
  app.addHook('onClose', async () => clearInterval(lagTimer));
  gauge('in_flight', () => inFlight);
  gauge('loop_lag_ms', () => Math.round(lagMs));

  app.addHook('onRequest', (req, reply, done) => {
    const route = req.routeOptions.config || {};
    reply.header('X-Request-Id', req.id);
    reply.header('X-Instance', instanceId);
    // 排空阶段：请求照常处理，但告诉对端"这条连接用完就关"，下一次请求自然会连到其他进程
    if (state.draining) reply.header('Connection', 'close');
    if (route.cls === 'static') return done();
    reply.header('Cache-Control', 'no-store');
    if (route.cls === 'infra') return done();

    // 关卡一：准入。关键请求（支付回调、订单状态）有额外预留额度，过载时最后才被拒绝
    const critical = route.cls === 'critical';
    // 三个过载信号，任何一个触发都在这里直接拒绝（越早拒绝，代价越小）：在途请求数、事件循环延迟、数据库通道排队
    if (inFlight >= overload.maxInFlight + (critical ? overload.criticalReserve : 0) || (!critical && (lagMs > overload.loopLagShedMs || dbSaturated()))) {
      inc('shed', critical ? 'critical' : 'normal');
      return done(E.serverBusy(null, {retryAfterMs: Math.round(1000 + Math.random() * 2000)}));
    }
    inFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight--; } };
    reply.raw.once('finish', release);
    reply.raw.once('close', release);

    // 关卡二：鉴权。身份只来自签名令牌，不信任任何请求参数里的身份信息
    if (route.auth === 'ops') {
      const bearer = req.headers.authorization;
      const token = req.headers['x-ops-token'] || (typeof bearer === 'string' && bearer.startsWith('Bearer ') ? bearer.slice(7) : '');
      return done(isOps(token) ? undefined : E.forbidden());
    }
    if (flag('maintenance') && !critical) return done(E.featureDisabled('系统维护中，请稍后再试', {retryAfterMs: 10000}));
    if (route.auth) {
      const header = req.headers.authorization;
      const claims = typeof header === 'string' && header.startsWith('Bearer ') ? readToken(header.slice(7)) : null;
      if (!claims) return done(E.unauthenticated());
      if (route.auth === 'verified' && claims.lvl !== 1) return done(E.verifyRequired());
      req.claims = claims;
      touch(claims.sid);
    }
    done();
  });

  app.addHook('onResponse', (req, reply, done) => {
    const route = req.routeOptions.config || {};
    const name = req.routeOptions.url ? req.method + ' ' + req.routeOptions.url : 'unmatched';
    const ms = reply.elapsedTime;
    inc('http_requests', name + ',' + reply.statusCode);
    if (route.cls !== 'static' && route.cls !== 'infra') observe('http_ms', name, ms);
    const status = reply.statusCode;
    if (status >= 500 && status !== 503) log.error({trace: req.id, route: name, status, ms: Math.round(ms)}, 'request failed');
    else if (ms > config.app.slowMs) log.warn({trace: req.id, route: name, status, ms: Math.round(ms)}, 'slow request');
    else if (config.app.accessLogSample > 0 && Math.random() < config.app.accessLogSample) log.info({trace: req.id, route: name, status, ms: Math.round(ms), sub: req.claims?.sub}, 'access');
    done();
  });

  // 关卡四：错误映射。任何异常最终都变成 {code, message, traceId} 的稳定结构
  app.setErrorHandler((error, req, reply) => {
    let e = error;
    if (!(e instanceof AppError)) {
      if (e.validation || e.statusCode === 400) e = E.badRequest('请求参数有误');
      else if (e.statusCode === 413) e = new AppError('PAYLOAD_TOO_LARGE', 413, '请求内容过大');
      else if (e.statusCode === 415) e = new AppError('UNSUPPORTED_MEDIA_TYPE', 415, '请使用 JSON 格式提交');
      // 数据库不可用（排队满、断路、超时、断连）统一表现为"查询暂不可用"，绝不伪装成"无记录"
      else if ((e instanceof BusyError || e instanceof CircuitOpenError) && e.resource === 'db' || isInfraFailure(e)) {
        e = E.queryUnavailable(null, {retryAfterMs: Math.round(1500 + Math.random() * 1500)});
      } else {
        log.error({trace: req.id, err: error}, 'unhandled error');
        e = E.internal();
      }
    }
    if (e.extra.retryAfterMs) reply.header('Retry-After', Math.max(1, Math.ceil(e.extra.retryAfterMs / 1000)));
    inc('errors', e.code);
    reply.code(e.status).send({code: e.code, message: e.message, traceId: req.id, ...(e.code === 'QUERY_UNAVAILABLE' ? {state: 'unavailable'} : {}), ...e.extra});
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({code: 'NOT_FOUND', message: '接口不存在', traceId: req.id}));

  // ── 关卡三：参数校验（JSON Schema）。多余字段一律拒绝
  const str = (min, max) => ({type: 'string', minLength: min, maxLength: max});
  const obj = (properties, required = Object.keys(properties)) => ({type: 'object', additionalProperties: false, required, properties});
  const idParam = name => ({params: obj({[name]: str(10, 20)})});

  // 基础设施接口
  app.get('/healthz', {config: {cls: 'infra'}}, async () => ({ok: true}));
  // 就绪检查只反映"本实例能否接流量"，不探测共享依赖：否则数据库一抖，所有实例同时被摘除，反而造成全站不可用
  app.get('/readyz', {config: {cls: 'infra'}}, async (req, reply) => (state.draining ? reply.code(503).send({ok: false, reason: 'draining'}) : {ok: true, instance: instanceId}));
  // 依赖详情与指标只给运维（负载均衡健康检查只用 /readyz）。接入层也应禁止公网访问这两个路径
  const opsOnly = req => {
    const bearer = req.headers.authorization;
    const token = req.headers['x-ops-token'] || (typeof bearer === 'string' && bearer.startsWith('Bearer ') ? bearer.slice(7) : '');
    if (!isOps(token)) throw E.forbidden();
  };
  app.get('/healthz/deps', {config: {cls: 'infra'}}, async req => {
    opsOnly(req);
    return {mysql: dbState(), redis: redisReady() ? 'ready' : 'down', instance: instanceId};
  });
  app.get('/metrics', {config: {cls: 'infra'}}, async (req, reply) => {
    opsOnly(req);
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(await prometheusText());
  });

  // 业务接口 v1
  app.get('/api/v1/meta', async () => getMeta());
  app.post('/api/v1/session', {schema: {body: obj({channel: str(0, 32)}, [])}},
    async req => openSession({ip: req.ip, channel: req.body?.channel}));
  app.post('/api/v1/verify', {config: {auth: 'anon'}, schema: {body: obj({name: str(1, 40), idNo: str(15, 24), consent: obj({policyVersion: str(1, 40), accepted: {type: 'boolean'}})})}},
    async req => verifyIdentity({claims: req.claims, ip: req.ip, ...req.body}));
  app.post('/api/v1/query', {config: {auth: 'verified'}},
    async req => runQuery({claims: req.claims, traceId: req.id}));
  app.post('/api/v1/unlock/orders', {config: {auth: 'verified'}, schema: {body: obj({queryId: str(10, 20), recordId: str(10, 20)})}},
    async req => createOrder({claims: req.claims, ...req.body, idemKey: req.headers['idempotency-key']}));
  app.get('/api/v1/unlock/orders/:orderNo', {config: {auth: 'verified', cls: 'critical'}, schema: idParam('orderNo')},
    async req => getOrder({claims: req.claims, orderNo: req.params.orderNo}));
  app.post('/api/v1/unlock/orders/:orderNo/mock-pay', {config: {auth: 'verified'}, schema: idParam('orderNo')},
    async req => mockPay({claims: req.claims, orderNo: req.params.orderNo}));
  app.get('/api/v1/records/:recordId', {config: {auth: 'verified'}, schema: idParam('recordId')},
    async req => getRecord({claims: req.claims, recordId: req.params.recordId}));
  app.post('/api/v1/pay/notify', {config: {cls: 'critical'}},
    async req => handlePayNotify({rawBody: req.rawBody || '', timestamp: req.headers['x-pay-timestamp'], signature: req.headers['x-pay-signature']}));
  app.post('/api/v1/callbacks', {config: {auth: 'verified'}, schema: {body: obj({queryId: str(10, 20), timeWindow: str(1, 24), contactConsent: {type: 'boolean'}})}},
    async (req, reply) => {
      const ticket = await createCallback({claims: req.claims, ...req.body});
      return reply.code(ticket.created ? 201 : 200).send(ticket);
    });
  app.get('/api/v1/callbacks', {config: {auth: 'verified'}}, async req => listCallbacks({claims: req.claims}));
  app.post('/api/v1/callbacks/:id/withdraw', {config: {auth: 'verified'}, schema: idParam('id')},
    async req => withdrawCallback({claims: req.claims, id: req.params.id}));

  // 运营接口
  app.get('/ops/api/overview', {config: {auth: 'ops', cls: 'critical'}}, async () => overview());
  app.post('/ops/api/flags', {config: {auth: 'ops', cls: 'critical'}, schema: {body: obj({name: {type: 'string', enum: FLAG_NAMES}, value: {type: 'boolean'}})}},
    async req => { await setFlag(req.body.name, req.body.value); log.warn({flag: req.body.name, value: req.body.value}, 'flag changed'); return {ok: true}; });

  // 静态页面
  app.get('/', {config: {cls: 'static'}}, (req, reply) => sendAsset(req, reply, 'index.html'));
  app.get('/ops', {config: {cls: 'static'}}, (req, reply) => sendAsset(req, reply, 'ops.html'));
  app.get('/assets/:name', {config: {cls: 'static'}}, (req, reply) => sendAsset(req, reply, req.params.name));
  return app;
}
