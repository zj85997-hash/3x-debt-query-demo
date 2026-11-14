// 在"本机环境的配置"下执行任意脚本（自动带上 npm run dev 生成的密钥与私有 MySQL/Redis 的连接方式）。
// 例：npm run dev:exec -- scripts/import.mjs --kind assets --file fixtures/samples/assets.csv --source "样例台账"
//     npm run dev:exec -- scripts/seed.mjs --force
//     npm run dev:exec -- scripts/reset-activity.mjs
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';

const local = new URL('../.local/v2/', import.meta.url);
const read = async name => JSON.parse(await readFile(new URL(name, local), 'utf8').catch(() => { throw new Error('未找到本机环境，请先运行 npm run dev'); }));
const [secrets, pids] = [await read('secrets.json'), await read('pids.json')];
const [script, ...rest] = process.argv.slice(2);
if (!script) { console.error('用法：npm run dev:exec -- <脚本> [参数…]'); process.exit(2); }
const child = spawn(process.execPath, [script, ...rest], {stdio: 'inherit', env: {...process.env, ...secrets, APP_MODE: 'demo',
  DB_SOCKET: pids.mysqlSock, DB_USER: 'root', DB_PASSWORD: '', DB_NAME: 'debt_query', REDIS_SOCKET: pids.redisSock}});
child.on('exit', code => process.exit(code ?? 1));
