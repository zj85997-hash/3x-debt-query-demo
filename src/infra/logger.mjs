// 结构化日志：一行一个 JSON，直接写标准输出，由部署环境（阿里云 SLS 等）采集。
// 约定：日志里只允许出现内部编号（traceId、sub、订单号），不得出现姓名、证件号、手机号等个人信息。
import {config} from '../config.mjs';

const LEVELS = {debug: 10, info: 20, warn: 30, error: 40, silent: 99};
const threshold = LEVELS[config.app.logLevel] ?? LEVELS.warn;
const base = {app: 'debt-query', instance: process.env.DQ_INSTANCE || 'local-' + process.pid};

function write(level, fields, message) {
  if (LEVELS[level] < threshold) return;
  const line = {t: new Date().toISOString(), level, ...base, ...fields, msg: message};
  if (fields?.err instanceof Error) line.err = {name: fields.err.name, code: fields.err.code, message: fields.err.message, stack: fields.err.stack};
  process.stdout.write(JSON.stringify(line) + '\n');
}
export const log = {
  debug: (fields, message) => write('debug', fields, message),
  info: (fields, message) => write('info', fields, message),
  warn: (fields, message) => write('warn', fields, message),
  error: (fields, message) => write('error', fields, message),
  // 审计通道：不受日志级别影响，始终输出。它是查询审计的第二份记录，用于与数据库对账。
  audit: (fields) => process.stdout.write(JSON.stringify({t: new Date().toISOString(), level: 'audit', ...base, ...fields}) + '\n')
};
export const instanceId = base.instance;
