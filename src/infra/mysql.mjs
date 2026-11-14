// MySQL 访问层。数据库是唯一事实来源：台账、转让记录、订单、预约、授权记录、查询审计都以这里为准。
// 保护措施：① 舱壁限制并发与排队 ② 每条语句有超时 ③ 断路器在数据库故障时快速失败 ④ 超时连接直接销毁不复用
import mysql from 'mysql2/promise';
import {readFileSync} from 'node:fs';
import {config} from '../config.mjs';
import {Bulkhead} from './bulkhead.mjs';
import {Breaker} from './breaker.mjs';
import {inc, observe} from './metrics.mjs';

const {db} = config;
export const pool = mysql.createPool({
  ...(db.socketPath ? {socketPath: db.socketPath} : {host: db.host, port: db.port}),
  user: db.user, password: db.password, database: db.database,
  connectionLimit: db.poolSize, queueLimit: 0, waitForConnections: true,
  maxIdle: db.poolSize, idleTimeout: 600000, enableKeepAlive: true, keepAliveInitialDelay: 10000,
  connectTimeout: 2000, charset: 'utf8mb4', dateStrings: true,
  supportBigNumbers: true, bigNumberStrings: true,
  ...(process.env.DB_CA_FILE ? {ssl: {ca: readFileSync(process.env.DB_CA_FILE)}} : {})
});
// 服务端兜底：SELECT 超过 1.5 秒由数据库自行终止；行锁等待最多 3 秒
pool.pool.on('connection', connection => {
  connection.query(`SET SESSION max_execution_time=${db.queryTimeoutMs}, innodb_lock_wait_timeout=3, time_zone='+08:00'`);
});

// 数据库"自身出了问题"的错误：超时、断连、拒绝连接。唯一键冲突等业务性 SQL 错误不算。
const dbFault = error => error.fatal === true ||
  ['PROTOCOL_SEQUENCE_TIMEOUT', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'ER_QUERY_TIMEOUT', 'ENOENT'].includes(error.code);
// 对外统一表现为"暂不可用"的错误：数据库故障，或本进程的数据库通道已排满
const infraFailure = error => error.name === 'BusyError' || dbFault(error);
const gate = new Bulkhead({name: 'db', maxConcurrent: db.poolSize, maxQueue: db.queueMax, queueWaitMs: db.queueWaitMs});
// 两道闸各管各的：舱壁管"我们自己太忙"（只拒绝排不进队的那部分请求），断路器管"数据库坏了"（全部快速失败）。
// 排队满不计入断路器——否则一过载就整体跳闸，把还能正常处理的请求也一并拒掉（容量摸高测试中曾因此在 2000 在途时吞吐骤降 93%）。
const breaker = new Breaker({name: 'db', windowSize: 20, minCalls: 8, failureRate: 0.5, openMs: 2000, isFailure: dbFault});

async function withConnection(work) {
  return gate.run(() => breaker.exec(async () => {
    const begin = performance.now();
    const connection = await pool.getConnection();
    let broken = false;
    try {
      return await work(connection);
    } catch (error) {
      if (dbFault(error)) { broken = true; inc('db_errors', error.code || error.name); }
      throw error;
    } finally {
      if (broken) connection.destroy(); else connection.release();
      observe('db_ms', '', performance.now() - begin);
    }
  }));
}
/** 执行单条预编译语句，返回行数组或写入结果 */
export function q(sql, args = [], timeout = db.queryTimeoutMs) {
  return withConnection(async connection => (await connection.execute({sql, timeout}, args))[0]);
}
/** 批量写入（VALUES ? 展开），用于审计批量落库 */
export function bulk(sql, rows, timeout = 5000) {
  return withConnection(async connection => (await connection.query({sql, timeout}, [rows]))[0]);
}
/** 事务：work 收到一个 run(sql,args) 函数；抛错即回滚 */
export function tx(work) {
  return withConnection(async connection => {
    const run = async (sql, args = []) => (await connection.execute({sql, timeout: db.queryTimeoutMs}, args))[0];
    await connection.beginTransaction();
    try {
      const result = await work(run);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    }
  });
}
export const dbState = () => breaker.state;
/** 数据库通道是否已接近排满（排队数超过上限的 90%）。准入关卡据此"及早拒绝"，不让注定排不上队的请求白白消耗处理资源 */
export const dbSaturated = () => gate.queued >= db.queueMax * 0.9;
export const isInfraFailure = infraFailure;
