// V1（Codex 原 Demo）基线压测计划：在重构之前，用同一台机器量出旧架构的真实水位与失效方式。
// 仅用于复现历史基线（结果见 bench/reports/v1-baseline.json）。被测对象是 main 分支上的旧版代码：
//   在 main 的检出目录里执行 npm ci && npm run local 启动旧版，然后把工作目录切到那里再运行本文件（需要读取旧版的 .local/mysql.pid）。
// 注意：阶段 B / C2 会把旧版压垮并耗尽本机临时端口，每个阶段之间要间隔 30 秒以上。
import {writeFile, readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {runPhase, printPhase, here} from '../lib/engine.mjs';

const base = process.env.BASE || 'http://127.0.0.1:8930';
const only = (process.env.ONLY || '').split(',').filter(Boolean);
const want = id => !only.length || only.includes(id);
const S = name => here(import.meta, '../scenarios/v1/' + name + '.mjs');
const phases = [];
const run = async (id, o) => {
  if (!want(id)) return;
  try { const r = await runPhase({base, ...o}); r.id = id; printPhase(r); phases.push(r); }
  catch (error) { console.error('阶段 ' + id + ' 失败：' + error.message); phases.push({id, name: o.name, error: error.message}); }
  await sleep(1500);
};
const pidOnPort = port => { try { return Number(execFileSync('lsof', ['-ti', 'tcp:' + port, '-sTCP:LISTEN']).toString().trim().split('\n')[0]); } catch { return 0; } };

await run('A', {name: 'A 旧口径复现：500 会话 · 思考 2–4s · 只读', scenario: S('read'), vus: 500, durationMs: 30000, think: [2000, 4000], rampMs: 2000});
await run('B', {name: 'B 500 个请求持续在途 · 无思考时间 · 只读', scenario: S('read'), vus: 500, durationMs: 20000});
await run('C', {name: 'C 500 人完整旅程 · 每步思考 1–3s（含登录/解锁/预约写入）', scenario: S('journey'), vus: 500, durationMs: 40000, think: [1000, 3000], rampMs: 3000});
await run('C2', {name: 'C2 500 人完整旅程 · 无思考时间（极限）', scenario: S('journey'), vus: 500, durationMs: 20000});
await run('D', {name: 'D 洪峰：500 人同一时刻发起完整旅程', scenario: S('journey'), vus: 500, mode: 'once'});
await run('E', {name: 'E 枚举攻击：单会话 50 并发遍历 1 万个尾号', scenario: S('enumerate'), vus: 50, durationMs: 15000, workers: 1, params: {threads: 1}});
await run('G', {name: 'G 故障注入：数据库停顿 6 秒（200 人只读负载下）', scenario: S('read'), vus: 200, durationMs: 24000, think: [200, 600],
  onStart: async () => {
    const pid = Number((await readFile('.local/mysql.pid', 'utf8')).trim());
    await sleep(6300); process.kill(pid, 'SIGSTOP');
    await sleep(6000); process.kill(pid, 'SIGCONT');
    return {injected: 'SIGSTOP mysqld 6s at t=6s', pid};
  }});
await run('F', {name: 'F 故障注入：强杀一个 API 实例（200 人只读负载下）', scenario: S('read'), vus: 200, durationMs: 24000, think: [200, 600],
  onStart: async () => {
    const pid = pidOnPort(8931);
    await sleep(8300); if (pid) process.kill(pid, 'SIGKILL');
    await sleep(12000);
    return {injected: 'SIGKILL api-a at t=8s', pid, restartedBySupervisor: pidOnPort(8931) !== 0};
  }});

const out = process.env.REPORT || 'bench/reports/v1-baseline.json';
await writeFile(out, JSON.stringify({date: new Date().toISOString(), target: 'V1 (Codex 原 Demo, main@37f4d4b)', base,
  host: {cpu: 'Apple M4 · 10 核', mem: '16 GB', os: process.platform + ' ' + process.arch, node: process.version}, phases}, null, 2) + '\n');
console.log('\n报告已写入 ' + out);
