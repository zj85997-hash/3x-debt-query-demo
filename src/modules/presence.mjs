// 活跃用户统计：回答"现在有多少人在同时使用"。
// 每个进程把 1 秒内见到的会话号攒起来，一次性写入 Redis 的基数统计结构（HyperLogLog，每 10 秒一个桶）；
// 大盘取最近 6 个桶的并集，即"近 60 秒活跃用户数"。属于非关键路径，写失败直接丢弃。
import {redis, key} from '../infra/redis.mjs';

const seen = new Set();
let timer;
export const touch = sid => { if (sid && seen.size < 50000) seen.add(sid); };
export function startPresence() {
  timer = setInterval(() => {
    if (!seen.size) return;
    const bucket = key('act', Math.floor(Date.now() / 10000));
    const members = [...seen];
    seen.clear();
    redis.pipeline().pfadd(bucket, ...members).expire(bucket, 90).exec().catch(() => {});
  }, 1000);
  timer.unref();
}
export const stopPresence = () => clearInterval(timer);
export function activeUsers() {
  const now = Math.floor(Date.now() / 10000);
  return redis.pfcount(...Array.from({length: 6}, (_, i) => key('act', now - i)));
}
