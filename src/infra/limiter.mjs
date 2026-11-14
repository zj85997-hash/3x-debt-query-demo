// 频率限制：令牌桶。主实现放在 Redis（多实例共享同一组计数），Redis 不可用时退化为进程内令牌桶。
// 一次请求可同时检查多个桶（例如"同一会话 + 同一 IP + 同一证件"），全部通过才扣减，任何一个不足都拒绝。
import {redis, key} from './redis.mjs';
import {inc} from './metrics.mjs';

const LUA = `
local now = tonumber(ARGV[1])
local n = #KEYS
local state = {}
local retry = 0
for i = 1, n do
  local cap = tonumber(ARGV[(i-1)*3+2])
  local rate = tonumber(ARGV[(i-1)*3+3])
  local cost = tonumber(ARGV[(i-1)*3+4])
  local d = redis.call('HMGET', KEYS[i], 't', 'ts')
  local tokens = tonumber(d[1])
  local ts = tonumber(d[2])
  if tokens == nil then tokens = cap; ts = now end
  tokens = math.min(cap, tokens + math.max(0, now - ts) * rate)
  state[i] = {tokens, cap, rate, cost}
  if tokens < cost then
    local wait = math.ceil((cost - tokens) / rate)
    if wait > retry then retry = wait end
  end
end
for i = 1, n do
  local s = state[i]
  local tokens = s[1]
  if retry == 0 then tokens = math.min(s[2], tokens - s[4]) end
  redis.call('HSET', KEYS[i], 't', tostring(tokens), 'ts', now)
  redis.call('PEXPIRE', KEYS[i], math.ceil(s[2] / s[3]) + 1000)
end
return {retry == 0 and 1 or 0, retry}
`;
redis.defineCommand('rlTake', {lua: LUA});

const local = new Map();
function takeLocal(buckets, now, cost) {
  let retry = 0;
  const states = buckets.map(b => {
    const s = local.get(b.key) || {tokens: b.capacity, ts: now};
    s.tokens = Math.min(b.capacity, s.tokens + Math.max(0, now - s.ts) * (b.perSec / 1000));
    s.ts = now;
    if (s.tokens < cost) retry = Math.max(retry, Math.ceil((cost - s.tokens) / (b.perSec / 1000)));
    return s;
  });
  states.forEach((s, i) => { if (!retry) s.tokens = Math.min(buckets[i].capacity, s.tokens - cost); local.set(buckets[i].key, s); });
  if (local.size > 50000) for (const k of local.keys()) { local.delete(k); if (local.size <= 25000) break; }
  return {allowed: retry === 0, retryAfterMs: retry};
}

/**
 * 取令牌。
 * @param {{key:string, capacity:number, perSec:number}[]} buckets
 * @returns {Promise<{allowed:boolean, retryAfterMs:number, degraded?:boolean}>}
 */
export async function take(buckets, cost = 1) {
  const now = Date.now();
  try {
    const keys = buckets.map(b => key('rl', b.key));
    const args = [now];
    for (const b of buckets) args.push(b.capacity, b.perSec / 1000, cost);
    const [allowed, retry] = await redis.rlTake(keys.length, ...keys, ...args);
    return {allowed: allowed === 1, retryAfterMs: Number(retry)};
  } catch {
    inc('limiter_fallback');
    return {...takeLocal(buckets, now, cost), degraded: true};
  }
}
/** 退还令牌：请求因为"系统自己的原因"（排队、下游故障）没办成时，不应占用用户的频率额度 */
export const refund = buckets => take(buckets, -1).catch(() => {});
