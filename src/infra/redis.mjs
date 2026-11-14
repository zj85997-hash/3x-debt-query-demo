// Redis 连接。定位：加速与削峰层（限流计数、核验缓存、查询回执、事件流、实时统计），不是唯一事实来源。
// 关键设置：断线时命令立即失败（不排队）、单条命令 300ms 超时——保证 Redis 故障时调用方能迅速走降级路径。
import Redis from 'ioredis';
import {config} from '../config.mjs';
import {log} from './logger.mjs';
import {gauge, inc} from './metrics.mjs';

const target = config.redis.socketPath ? {path: config.redis.socketPath} : config.redis.url || 'redis://127.0.0.1:6379';
const common = {
  protocol: 2,                       // 固定使用 RESP2，返回结构与各版本云 Redis 一致
  connectTimeout: 1500,
  enableOfflineQueue: false,         // 未连接时命令立即报错，由调用方降级
  maxRetriesPerRequest: 0,
  retryStrategy: times => Math.min(200 * times, 2000),
  keyPrefix: ''
};
function create(extra = {}) {
  const options = {...common, ...extra};
  const client = typeof target === 'string' ? new Redis(target, options) : new Redis({...target, ...options});
  client.on('error', error => { inc('redis_errors'); log.debug({code: error.code}, 'redis error'); });
  return client;
}
/** 普通命令连接（带超时） */
export const redis = create({commandTimeout: config.redis.commandTimeoutMs});
/** 阻塞读专用连接（事件消费者使用，不能设置命令超时） */
export const createBlockingClient = () => create({});
export const redisReady = () => redis.status === 'ready';

// 假死探测：连接还在但 Redis 不回包（主机卡顿、主从切换中）是最难处理的故障——每条命令都要等到超时才失败，
// 会把每个请求都拖慢几百毫秒。这里每 500ms 探测一次，连续两次无响应就主动断开重连；
// 重连成功之前所有命令立即失败，调用方直接走降级路径（本地限流、直连数据库、审计备用通道）。
let missed = 0;
const probe = setInterval(async () => {
  if (redis.status !== 'ready') { missed = 0; return; }
  try { await redis.ping(); missed = 0; }
  catch {
    if (++missed >= 2) { missed = 0; inc('redis_forced_reconnect'); log.warn({}, 'redis not responding, forcing reconnect'); redis.disconnect(true); }
  }
}, 500);
probe.unref();
gauge('redis_ready', () => (redisReady() ? 1 : 0));
export const key = (...parts) => config.redis.prefix + parts.join(':');
