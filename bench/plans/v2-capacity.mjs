// V2 容量摸高：量出"查询链路"在本机的上限，用来计算容量余量（验收负载只占上限的多少）。
// 做法：另起一组专用进程（端口 8900，独立的 Redis 键前缀），放开查询限流、关闭结果缓存，让每次查询都真实打到数据库并写审计流水；
//       然后逐级加压（100 → 2000 个不间断查询的虚拟用户）。数据库与 Redis 复用 npm run dev 的私有实例。
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile, writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {runPhase, printPhase, here} from '../lib/engine.mjs';
import {env, sleep} from '../lib/stack.mjs';

const secrets = JSON.parse(await readFile(new URL('../../.local/v2/secrets.json', import.meta.url), 'utf8'));
const port = 8900;
const base = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, [fileURLToPath(new URL('../../src/supervisor.mjs', import.meta.url))], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {...process.env, ...secrets, APP_MODE: 'demo', PORT: String(port), TRUST_PROXY: 'loopback', NODE_NAME: 'cap', API_WORKERS: process.env.API_WORKERS || '4',
    DB_SOCKET: env.mysqlSock, DB_USER: 'root', DB_NAME: 'debt_query', REDIS_SOCKET: env.redisSock, REDIS_PREFIX: 'dqcap:',
    VERIFY_PROVIDER_URL: env.providerBase, PAY_PROVIDER_URL: env.providerBase,
    RL_QUERY_SUB_BURST: '1000000000', RL_QUERY_SUB_PER_MIN: '1000000000', QUERY_RESULT_CACHE_SEC: '0', MAX_IN_FLIGHT: '5000'}
});
const out = createWriteStream(new URL('../../.local/v2/logs/capacity.log', import.meta.url), {flags: 'w'});
app.stdout.pipe(out);
app.stderr.pipe(out);
const phases = [];
try {
  let ready = false;
  for (let i = 0; i < 75 && !ready; i++) { try { ready = (await fetch(base + '/readyz')).ok; } catch { /* 等待启动 */ } if (!ready) await sleep(200); }
  if (!ready) throw new Error('专用实例未能启动，详见 .local/v2/logs/capacity.log');
  for (const vus of (process.env.STEPS || '100,250,500,1000,2000').split(',').map(Number)) {
    const report = await runPhase({name: `查询链路 · ${vus} 个请求持续在途`, scenario: here(import.meta, '../scenarios/v2/query-only.mjs'), base, vus, durationMs: 15000, workers: 4});
    report.vus = vus;
    printPhase(report);
    phases.push(report);
    await sleep(3000);
  }
} finally {
  app.kill('SIGTERM');
  await Promise.race([once(app, 'exit'), sleep(20000)]);
}
const best = phases.reduce((a, b) => ((b.metrics.query?.ok ?? 0) / b.elapsedSeconds > (a.metrics.query?.ok ?? 0) / a.elapsedSeconds ? b : a));
const summary = phases.map(p => ({vus: p.vus, okPerSecond: Math.round((p.metrics.query?.ok ?? 0) / p.elapsedSeconds), p50: p.metrics.query?.p50, p95: p.metrics.query?.p95, p99: p.metrics.query?.p99,
  rejected: p.metrics.query?.soft ?? 0, failed: p.metrics.query?.fail ?? 0}));
console.table(summary);
const file = process.env.REPORT || 'bench/reports/v2-capacity.json';
await writeFile(file, JSON.stringify({date: new Date().toISOString(), target: 'V2 查询链路（限流放开、结果缓存关闭、4 个 API 进程）',
  host: {cpu: 'Apple M4 · 10 核', mem: '16 GB', os: process.platform + ' ' + process.arch, node: process.version},
  peakOkPerSecond: Math.round((best.metrics.query?.ok ?? 0) / best.elapsedSeconds), summary, phases}, null, 2) + '\n');
console.log('容量报告已写入 ' + file);
process.exit(0);
