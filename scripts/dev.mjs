// 本机一键环境：npm run dev
// 依次拉起 项目私有的 MySQL 与 Redis（各自独立数据目录、只走本机套接字，不占用也不影响系统里已有的 3306 / 6379）
// → 建表 → 导入虚构数据 → 第三方模拟器 → 应用（N 个 API 进程 + 1 个后台进程）。Ctrl+C 全部优雅退出。
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, readFile, writeFile, access, rm} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {createHash, randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import net from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = join(root, '.local', 'v2');
const logs = join(local, 'logs');
// 套接字路径有长度上限（约 100 字符），放在系统临时目录下并以项目路径哈希区分
const sockDir = join(tmpdir(), 'dq-' + createHash('sha256').update(local).digest('hex').slice(0, 10));
const mysqlSock = join(sockDir, 'mysql.sock');
const redisSock = join(sockDir, 'redis.sock');
const port = Number(process.env.PORT || 8800);
const providerPort = Number(process.env.PROVIDER_PORT || port + 10);
const children = [];
let closing = false;

const exists = path => access(path).then(() => true, () => false);
const socketAlive = path => new Promise(done => {
  const socket = net.connect(path);
  socket.once('connect', () => { socket.destroy(); done(true); });
  socket.once('error', () => done(false));
});
async function waitFor(check, what, tries = 150) {
  for (let i = 0; i < tries; i++) { if (await check()) return; await sleep(200); }
  throw new Error(what + ' 启动超时，请查看 ' + logs);
}
function start(name, command, args, options = {}) {
  const out = createWriteStream(join(logs, name + '.log'), {flags: 'a'});
  const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe'], ...options});
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.on('error', error => console.error(`[${name}] 无法启动：${error.message}`));
  child.on('exit', code => { if (!closing && options.essential !== false) { console.error(`[${name}] 意外退出（代码 ${code}），正在关闭整个环境…`); shutdown(1); } });
  children.push({name, child});
  return child;
}
async function run(name, script, env) {
  const child = spawn(process.execPath, [join(root, script)], {stdio: 'inherit', env, cwd: root});
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(name + ' 失败');
}
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const {name, child} of children.reverse()) {       // 反向顺序：应用 → 模拟器 → Redis → MySQL
    if (child.exitCode !== null) continue;
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), sleep(name === 'app' ? 16000 : 8000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await rm(join(local, 'pids.json'), {force: true});
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

try {
  await mkdir(logs, {recursive: true});
  await mkdir(sockDir, {recursive: true, mode: 0o700});
  await mkdir(join(local, 'redis'), {recursive: true});

  // 开发用密钥：首次生成后保存在 .local（已被 .gitignore 忽略）。盲索引密钥一旦更换，库里的匹配标识全部失效，需要重新导入数据。
  const secretsFile = join(local, 'secrets.json');
  let secrets;
  if (await exists(secretsFile)) secrets = JSON.parse(await readFile(secretsFile, 'utf8'));
  else {
    secrets = Object.fromEntries(['TOKEN_SECRET', 'ID_HASH_KEY', 'PAY_NOTIFY_SECRET', 'OPS_TOKEN'].map(k => [k, randomBytes(32).toString('hex')]));
    await writeFile(secretsFile, JSON.stringify(secrets, null, 2), {mode: 0o600});
  }
  const env = {
    ...process.env, ...secrets,
    APP_MODE: 'demo', HOST: '127.0.0.1', PORT: String(port), TRUST_PROXY: 'loopback', STATIC_LIVE: process.env.STATIC_LIVE || '1',
    API_WORKERS: process.env.API_WORKERS || '4', NODE_NAME: process.env.NODE_NAME || 'local',
    DB_SOCKET: mysqlSock, DB_USER: 'root', DB_PASSWORD: '', DB_NAME: 'debt_query', REDIS_SOCKET: redisSock,
    VERIFY_PROVIDER_URL: `http://127.0.0.1:${providerPort}`, PAY_PROVIDER_URL: `http://127.0.0.1:${providerPort}`,
    PAY_NOTIFY_URL: `http://127.0.0.1:${port}/api/v1/pay/notify`, PROVIDER_PORT: String(providerPort)
  };

  // 1. MySQL（私有实例）
  if (await socketAlive(mysqlSock)) console.log('· 复用已在运行的私有 MySQL');
  else {
    const data = join(local, 'mysql');
    if (!await exists(join(data, 'mysql.ibd'))) {
      console.log('· 首次运行：初始化私有 MySQL 数据目录…');
      await mkdir(data, {recursive: true, mode: 0o700});
      const init = spawn('mysqld', ['--no-defaults', '--initialize-insecure', '--datadir=' + data], {stdio: 'ignore'});
      const [code] = await once(init, 'exit');
      if (code !== 0) throw new Error('mysqld 初始化失败（请确认已安装 MySQL 并在 PATH 中）');
    }
    start('mysql', 'mysqld', ['--no-defaults', '--datadir=' + data, '--socket=' + mysqlSock, '--skip-networking', '--mysqlx=OFF',
      '--pid-file=' + join(local, 'mysql.pid'), '--log-error=' + join(logs, 'mysql-error.log'),
      '--innodb-buffer-pool-size=1G', '--innodb-redo-log-capacity=1G', '--max-connections=300']);
    await waitFor(() => socketAlive(mysqlSock), 'MySQL');
  }
  // 2. Redis（私有实例，开启 AOF 每秒落盘）
  if (await socketAlive(redisSock)) console.log('· 复用已在运行的私有 Redis');
  else {
    start('redis', 'redis-server', ['--port', '0', '--unixsocket', redisSock, '--unixsocketperm', '700', '--dir', join(local, 'redis'),
      '--appendonly', 'yes', '--appendfsync', 'everysec', '--save', '', '--pidfile', join(local, 'redis.pid'), '--daemonize', 'no']);
    await waitFor(() => socketAlive(redisSock), 'Redis');
  }
  // 3. 表结构与演示数据
  await run('数据库迁移', 'scripts/migrate.mjs', env);
  await run('演示数据导入', 'scripts/seed.mjs', env);
  // 4. 第三方模拟器
  start('provider-sim', process.execPath, [join(root, 'mocks/provider-sim.mjs')], {env, cwd: root});
  // 5. 应用
  const app = start('app', process.execPath, [join(root, 'src/supervisor.mjs')], {env, cwd: root});
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(base + '/readyz', {signal: AbortSignal.timeout(800)})).ok; } catch { return false; } }, '应用');

  const pidOf = name => children.find(c => c.name === name)?.child.pid ?? null;
  await writeFile(join(local, 'pids.json'), JSON.stringify({dev: process.pid, supervisor: app.pid, mysql: pidOf('mysql'), redis: pidOf('redis'), provider: pidOf('provider-sim'),
    base, providerBase: `http://127.0.0.1:${providerPort}`, opsToken: secrets.OPS_TOKEN, mysqlSock, redisSock}, null, 2));
  console.log(`
  个人债权信息查询平台 · 本机环境已就绪
  ─────────────────────────────────────────────
  用户端 H5     ${base}/
  运营大盘      ${base}/ops#token=${secrets.OPS_TOKEN}
  API 进程数    ${env.API_WORKERS}（共享端口 ${port}）＋ 后台进程 1 个
  日志目录      ${logs}
  停止          Ctrl+C
`);
} catch (error) {
  console.error('启动失败：' + error.message);
  await shutdown(1);
}
