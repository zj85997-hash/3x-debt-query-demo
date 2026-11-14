// 动态开关与数据版本号（对标"动态运营"）：运营人员不发版即可调整系统行为，例如临时关闭付费解锁、进入维护模式。
// 同步方式：开关保存在 Redis 哈希中；变更时通过发布订阅即时通知所有进程（通常百毫秒内生效），
// 另有每 2 秒一次的轮询兜底（订阅连接断开期间也最迟 2 秒生效）。Redis 不可用时沿用最近一次的值。
import {redis, key, createBlockingClient} from './redis.mjs';

export const FLAG_NAMES = ['maintenance', 'unlock_off', 'callback_off', 'new_session_off'];
export const CHANGED_CHANNEL = key('flags:changed');
const current = Object.fromEntries(FLAG_NAMES.map(name => [name, false]));
let version = '0';
let timer, subscriber;

async function refresh() {
  try {
    const [[, raw], [, ver]] = await redis.pipeline().hgetall(key('flags')).get(key('dataver')).exec();
    for (const name of FLAG_NAMES) current[name] = raw?.[name] === '1';
    version = ver || '0';
  } catch { /* 沿用旧值 */ }
}
export function startFlags() {
  refresh();
  timer = setInterval(refresh, 2000);
  timer.unref();
  subscriber = createBlockingClient();
  subscriber.on('ready', () => subscriber.subscribe(CHANGED_CHANNEL).catch(() => {}));
  subscriber.on('message', () => refresh());
}
export function stopFlags() {
  clearInterval(timer);
  subscriber?.disconnect();
}
export const flag = name => current[name] === true;
export const allFlags = () => ({...current});
/** 数据版本号：每次导入或撤销批次后加一。查询结果缓存的键里带着它，所以数据一变，旧缓存自然作废 */
export const dataVersion = () => version;
export async function setFlag(name, value) {
  if (!FLAG_NAMES.includes(name)) throw new Error('unknown flag');
  await redis.hset(key('flags'), name, value ? '1' : '0');
  current[name] = !!value;
  await redis.publish(CHANGED_CHANNEL, name).catch(() => {});
}
