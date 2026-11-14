// 清空业务流水（查询审计、授权记录、订单、解锁授权、预约、统计）与 Redis 中本应用的全部键，保留台账等基础数据。
// 用途：正式验收压测之前，把环境恢复到"还没有人用过"的状态，保证报告可复现。只应在本机或测试环境使用。
import mysql from 'mysql2/promise';
import Redis from 'ioredis';
import {config} from '../src/config.mjs';

if (config.app.mode !== 'demo') throw new Error('只允许在 demo 模式下清空数据');
const {db} = config;
const connection = await mysql.createConnection({...(db.socketPath ? {socketPath: db.socketPath} : {host: db.host, port: db.port}), user: db.user, password: db.password, database: db.database});
for (const table of ['query_logs', 'consents', 'unlock_orders', 'unlock_grants', 'callback_tickets', 'stat_daily']) await connection.query('TRUNCATE TABLE ' + table);
await connection.end();
const redis = config.redis.socketPath ? new Redis({path: config.redis.socketPath, protocol: 2}) : new Redis(config.redis.url || 'redis://127.0.0.1:6379', {protocol: 2});
let cursor = '0', removed = 0;
do {
  const [next, keys] = await redis.scan(cursor, 'MATCH', config.redis.prefix + '*', 'COUNT', 1000);
  cursor = next;
  const targets = keys.filter(k => !k.startsWith(config.redis.prefix + 'node:'));   // 节点号租约属于运行中的进程，不能删
  if (targets.length) removed += await redis.del(...targets);
} while (cursor !== '0');
redis.disconnect();
console.log(`业务流水已清空；Redis 删除 ${removed} 个键`);
