// 单节点进程管理器：一条命令拉起 N 个 API 进程（共享同一个端口）和 1 个后台进程。
//   · 任何子进程异常退出都会被自动拉起（连续崩溃时退避重试）
//   · SIGHUP：滚动重启——逐个替换 API 进程，过程中端口不中断（单节点上的平滑发布）
//   · SIGTERM / SIGINT：通知全部子进程优雅下线后退出
// 多节点部署时，每台机器各跑一个本进程，前面由负载均衡（阿里云 ALB）分发。
import cluster from 'node:cluster';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {hostname} from 'node:os';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {config} from './config.mjs';
import {log} from './infra/logger.mjs';

if (!cluster.isPrimary) throw new Error('supervisor 只能作为主进程运行');
const node = process.env.NODE_NAME || hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'node';
const apiEntry = fileURLToPath(new URL('./api/main.mjs', import.meta.url));
const workerEntry = fileURLToPath(new URL('./worker/main.mjs', import.meta.url));
cluster.setupPrimary({exec: apiEntry});

let stopping = false;
const slots = new Map();       // 槽位号 → API 进程
const backoff = new Map();     // 槽位 → 下次重启前的等待
let background = null;

function restartDelay(name, startedAt) {
  const quick = Date.now() - startedAt < 5000;                  // 启动 5 秒内就退出，视为连续崩溃
  const delay = quick ? Math.min((backoff.get(name) || 100) * 2, 5000) : 200;
  backoff.set(name, quick ? delay : 100);
  return delay;
}
function startApi(slot) {
  const startedAt = Date.now();
  const worker = cluster.fork({DQ_INSTANCE: `${node}-api-${slot}`});
  slots.set(slot, worker);
  worker.on('exit', (code, signal) => {
    if (slots.get(slot) !== worker) return;                     // 已被滚动重启替换
    slots.delete(slot);
    if (stopping) return;
    const delay = restartDelay('api-' + slot, startedAt);
    log.warn({slot, code, signal, delay}, 'api process exited, restarting');
    setTimeout(() => { if (!stopping) startApi(slot); }, delay);
  });
  return worker;
}
function startBackground() {
  const startedAt = Date.now();
  background = fork(workerEntry, {env: {...process.env, DQ_INSTANCE: `${node}-worker`}});
  const child = background;
  child.on('exit', (code, signal) => {
    if (background === child) background = null;
    if (stopping) return;
    const delay = restartDelay('worker', startedAt);
    log.warn({code, signal, delay}, 'worker process exited, restarting');
    setTimeout(() => { if (!stopping) startBackground(); }, delay);
  });
}
const waitReady = child => new Promise(resolve => {
  const timer = setTimeout(resolve, 8000);
  child.on('message', message => { if (message?.type === 'ready') { clearTimeout(timer); resolve(); } });
  child.once('exit', () => { clearTimeout(timer); resolve(); });
});

let rolling = false;
async function rollingRestart() {
  if (rolling || stopping) return;
  rolling = true;
  log.warn({}, 'rolling restart begin');
  for (const slot of [...slots.keys()].sort()) {
    if (stopping) break;
    const old = slots.get(slot);
    const fresh = startApi(slot);          // 新进程先起来、先接流量
    await waitReady(fresh);
    old?.process.kill('SIGTERM');          // 旧进程处理完在途请求后退出
    if (old && !old.isDead()) await Promise.race([once(old, 'exit'), sleep(config.app.drainGraceMs + 14000)]);
  }
  // 后台进程最后重启：退出后由上面的自动拉起逻辑启动新版本；期间事件留在事件流里，不会丢
  if (!stopping && background) background.kill('SIGTERM');
  rolling = false;
  log.warn({}, 'rolling restart done');
}
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  const children = [...slots.values()].map(w => w.process);
  if (background) children.push(background);
  for (const child of children) child.kill('SIGTERM');
  await Promise.race([Promise.all(children.map(c => (c.exitCode !== null || c.signalCode ? null : once(c, 'exit')))), sleep(config.app.drainGraceMs + 14000)]);
  process.exit(0);
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGHUP', rollingRestart);

for (let slot = 1; slot <= config.app.apiWorkers; slot++) startApi(slot);
startBackground();
log.warn({node, apiWorkers: config.app.apiWorkers, port: config.app.port, pid: process.pid}, 'supervisor started');
