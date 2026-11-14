// API 进程入口（无状态，可任意多开）。负责生命周期：启动 → 接流量 → 收到停止信号后优雅下线。
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {config} from '../config.mjs';
import {log} from '../infra/logger.mjs';
import {redis} from '../infra/redis.mjs';
import {pool} from '../infra/mysql.mjs';
import {acquireNodeId, releaseNodeId} from '../infra/node-id.mjs';
import {startFlags, stopFlags} from '../infra/flags.mjs';
import {startSnapshots, stopSnapshots} from '../modules/ops.mjs';
import {drainAudit} from '../modules/audit.mjs';
import {startPresence, stopPresence} from '../modules/presence.mjs';
import {closeVerifyProvider} from '../providers/verify-provider.mjs';
import {closePayProvider} from '../providers/pay-provider.mjs';
import {preloadAssets} from './static.mjs';
import {buildApp} from './app.mjs';

const state = {draining: false};
const app = buildApp(state);

// 向 Redis 租用全集群唯一的节点号（用于生成不重复的编号）
if (redis.status !== 'ready') await Promise.race([once(redis, 'ready'), sleep(1500)]).catch(() => {});
await acquireNodeId();

await preloadAssets();
startFlags();
startSnapshots('api');
startPresence();
// backlog：等待被接受的连接队列长度。实际生效值受操作系统上限约束（Linux 的 net.core.somaxconn，建议调到 4096）
await app.listen({port: config.app.port, host: config.app.host, backlog: 4096});
log.info({port: config.app.port}, 'api ready');
process.send?.({type: 'ready'});

// 优雅下线（发布、缩容、重启都走这里），目标是"用户无感"：
//   ① 标记排空：就绪检查变 503（负载均衡不再派新流量），所有响应带 Connection: close（已有长连接逐步迁走）
//   ② 宽限期内照常服务
//   ③ 停止监听、关闭空闲连接、等在途请求结束
//   ④ 写完暂存的审计，释放连接池后退出
async function shutdown(reason) {
  if (state.draining) return;
  state.draining = true;
  log.info({reason}, 'api draining');
  setTimeout(() => process.exit(1), config.app.drainGraceMs + 12000).unref();   // 兜底：超时强制退出
  await sleep(config.app.drainGraceMs);
  await app.close().catch(() => {});
  await drainAudit();
  await releaseNodeId();
  stopSnapshots();
  stopPresence();
  stopFlags();
  closeVerifyProvider();
  closePayProvider();
  await pool.end().catch(() => {});
  redis.disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// 未预期的异常：记录后退出，由进程管理器立即拉起新进程（"程序异常 → 自动拉起"）
process.on('uncaughtException', error => { log.error({err: error}, 'uncaught exception'); shutdown('uncaughtException'); });
process.on('unhandledRejection', error => { log.error({err: error instanceof Error ? error : new Error(String(error))}, 'unhandled rejection'); });
