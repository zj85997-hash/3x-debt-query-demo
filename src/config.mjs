// 配置的唯一入口：所有环境变量在这里读取、给默认值并校验。业务代码不得直接读 process.env。
const env = process.env;
const num = (key, fallback) => {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`配置项 ${key} 必须是数字，当前为 "${raw}"`);
  return value;
};
const str = (key, fallback) => (env[key] === undefined || env[key] === '' ? fallback : env[key]);
const secret = key => {
  const value = env[key];
  if (!value || value.length < 32) throw new Error(`缺少密钥 ${key}（至少 32 个字符）。本地开发请用 npm run dev 自动生成。`);
  return value;
};
// 反向代理信任：只信任"负载均衡自己的地址"，由它追加的那一条 X-Forwarded-For 才被当作用户 IP。
//   0（默认）= 不信任任何代理，服务直接对公网时必须如此；
//   否则填负载均衡的回源 IP / 网段，逗号分隔（也可用 loopback 表示本机，仅限本机开发与压测）。
// 刻意不支持"信任全部"：那样用户可以自己伪造 X-Forwarded-For，绕过所有按 IP 的限流。
export function parseTrustProxy(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') throw new Error('TRUST_PROXY 不能设为"信任全部"，请填写负载均衡的回源 IP 或网段，例如 100.64.0.0/10');
  const list = value.split(',').map(item => item.trim()).filter(Boolean);
  for (const item of list) {
    if (!['loopback', 'linklocal', 'uniquelocal'].includes(item) && !/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(item)) throw new Error('TRUST_PROXY 格式不正确：' + item);
  }
  return list;
}
const mode = str('APP_MODE', 'demo');
if (!['demo', 'prod'].includes(mode)) throw new Error('APP_MODE 只能是 demo 或 prod');

export const config = Object.freeze({
  app: {
    mode,                                         // demo：只接受虚构证件号、允许模拟支付；prod：关闭全部模拟入口
    host: str('HOST', '127.0.0.1'),
    port: num('PORT', 8800),
    apiWorkers: num('API_WORKERS', 4),            // 每个节点的 API 进程数
    trustProxy: parseTrustProxy(env.TRUST_PROXY),   // 见上方 parseTrustProxy 的说明
    logLevel: str('LOG_LEVEL', 'warn'),
    accessLogSample: num('ACCESS_LOG_SAMPLE', 0), // 正常请求的访问日志采样率；错误与慢请求始终记录
    slowMs: num('SLOW_MS', 800),
    // 下线宽限期：收到停止信号后仍照常服务这么久，期间每个响应都带 Connection: close，让客户端/负载均衡把连接迁走。
    // 生产环境应不小于负载均衡摘除实例所需的时间（建议 8000–10000）
    drainGraceMs: num('DRAIN_GRACE_MS', 1500)
  },
  db: {
    host: str('DB_HOST', '127.0.0.1'),
    port: num('DB_PORT', 3306),
    socketPath: str('DB_SOCKET', ''),
    user: str('DB_USER', 'root'),
    password: str('DB_PASSWORD', ''),
    database: str('DB_NAME', 'debt_query'),
    poolSize: num('DB_POOL_SIZE', 10),            // 每个进程的连接数；节点总连接 = 进程数 × poolSize
    queueMax: num('DB_QUEUE_MAX', 400),           // 等待连接的最大排队数，超过立即拒绝
    queueWaitMs: num('DB_QUEUE_WAIT_MS', 800),    // 排队等待上限，超时即快速失败
    queryTimeoutMs: num('DB_QUERY_TIMEOUT_MS', 1500)
  },
  redis: {
    url: str('REDIS_URL', ''),                    // 例如 redis://:password@host:6379/0
    socketPath: str('REDIS_SOCKET', ''),
    commandTimeoutMs: num('REDIS_COMMAND_TIMEOUT_MS', 300),
    prefix: str('REDIS_PREFIX', 'dq:')
  },
  security: {
    tokenSecret: secret('TOKEN_SECRET'),          // 会话令牌签名密钥
    idHashKey: secret('ID_HASH_KEY'),             // 证件号盲索引密钥（生产环境由 KMS 托管，不可更换）
    payNotifySecret: secret('PAY_NOTIFY_SECRET'), // 支付回调验签密钥
    opsToken: secret('OPS_TOKEN')                 // 运营大盘访问令牌
  },
  session: {
    anonTtlSec: num('SESSION_ANON_TTL_SEC', 3600),
    verifiedTtlSec: num('SESSION_VERIFIED_TTL_SEC', 1800)
  },
  // 频率限制：capacity=桶容量（允许的突发量），perSec=每秒补充量
  limits: {
    sessionIp: {capacity: num('RL_SESSION_IP_BURST', 30), perSec: num('RL_SESSION_IP_PER_MIN', 30) / 60},
    verifySid: {capacity: num('RL_VERIFY_SID_BURST', 5), perSec: num('RL_VERIFY_SID_PER_10MIN', 5) / 600},
    // 按 IP 的限流只是粗粒度兜底：移动网络下大量用户共用出口 IP，设得太紧会误伤，主要约束靠"会话（微信 openid）"与"证件"两个维度
    verifyIp: {capacity: num('RL_VERIFY_IP_BURST', 60), perSec: num('RL_VERIFY_IP_PER_10MIN', 60) / 600},
    verifyId: {capacity: num('RL_VERIFY_ID_BURST', 10), perSec: num('RL_VERIFY_ID_PER_DAY', 10) / 86400},
    querySub: {capacity: num('RL_QUERY_SUB_BURST', 10), perSec: num('RL_QUERY_SUB_PER_MIN', 10) / 60},
    writeSub: {capacity: num('RL_WRITE_SUB_BURST', 20), perSec: num('RL_WRITE_SUB_PER_HOUR', 60) / 3600},
    verifyDailyBudget: num('VERIFY_DAILY_BUDGET', 200000) // 每日核验次数预算（成本熔断）
  },
  overload: {
    maxInFlight: num('MAX_IN_FLIGHT', 600),       // 每进程普通请求在途上限
    criticalReserve: num('CRITICAL_RESERVE', 200),// 为支付回调、订单状态等关键请求额外预留
    loopLagShedMs: num('LOOP_LAG_SHED_MS', 250)   // 事件循环延迟超过该值时开始拒绝普通请求
  },
  verify: {
    providerUrl: str('VERIFY_PROVIDER_URL', 'http://127.0.0.1:8810'),
    concurrency: num('VERIFY_CONCURRENCY', 40),   // 每进程对核验供应商的并发上限（= 供应商配额 ÷ 全部进程数）
    queueMax: num('VERIFY_QUEUE_MAX', 400),
    queueWaitMs: num('VERIFY_QUEUE_WAIT_MS', 3000),
    timeoutMs: num('VERIFY_TIMEOUT_MS', 2500),
    cacheOkSec: num('VERIFY_CACHE_OK_SEC', 86400),
    cacheFailSec: num('VERIFY_CACHE_FAIL_SEC', 600)
  },
  pay: {
    providerUrl: str('PAY_PROVIDER_URL', 'http://127.0.0.1:8810'),
    notifyUrl: str('PAY_NOTIFY_URL', 'http://127.0.0.1:8800/api/v1/pay/notify'),
    priceFen: num('UNLOCK_PRICE_FEN', 990),
    orderTtlSec: num('ORDER_TTL_SEC', 900),
    concurrency: num('PAY_CONCURRENCY', 30),
    timeoutMs: num('PAY_TIMEOUT_MS', 2500)
  },
  query: {
    resultCacheSec: num('QUERY_RESULT_CACHE_SEC', 30),
    receiptTtlSec: num('QUERY_RECEIPT_TTL_SEC', 86400)
  },
  events: {
    maxLen: num('EVENT_STREAM_MAXLEN', 2000000),
    batchSize: num('EVENT_BATCH_SIZE', 500),
    fallbackMax: num('EVENT_FALLBACK_MAX', 20000) // Redis 不可用时的本地暂存上限，超过则拒绝新查询
  },
  policy: {
    version: str('POLICY_VERSION', 'query-policy-2026-11'),
    callbackWindows: ['09:00–12:00', '12:00–15:00', '15:00–18:00']
  }
});
export const demoMode = config.app.mode === 'demo';
