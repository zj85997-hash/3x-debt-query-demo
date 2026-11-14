// 编号生成器的"节点号"分配：全集群同一时刻每个 API 进程必须持有不同的节点号（0–1023），否则可能生成重复编号。
// 做法：在 Redis 里以"租约"方式占号——占到后每 30 秒续期，进程退出时释放；进程异常死亡则 2 分钟后自动过期可被复用。
// Redis 在启动瞬间不可用时退化为随机节点号（极小概率重号，此时数据库主键约束是最后一道防线：重复写入会被拒绝并由客户端重试）。
import {randomInt} from 'node:crypto';
import {redis, key} from './redis.mjs';
import {setNode} from './ids.mjs';
import {instanceId, log} from './logger.mjs';

let held = null;
let heartbeat;
export async function acquireNodeId() {
  try {
    const start = randomInt(0, 1024);
    for (let i = 0; i < 1024; i++) {
      const id = (start + i) % 1024;
      if (await redis.set(key('node', id), instanceId, 'EX', 120, 'NX') === 'OK') {
        held = id;
        setNode(id);
        heartbeat = setInterval(() => redis.set(key('node', id), instanceId, 'EX', 120).catch(() => {}), 30000);
        heartbeat.unref();
        return id;
      }
    }
    throw new Error('节点号已全部被占用');
  } catch (error) {
    const fallback = randomInt(0, 1024);
    setNode(fallback);
    log.warn({code: error.code || error.message, node: fallback}, 'node id lease unavailable, using random node id');
    return fallback;
  }
}
export async function releaseNodeId() {
  clearInterval(heartbeat);
  if (held !== null) await redis.del(key('node', held)).catch(() => {});
  held = null;
}
