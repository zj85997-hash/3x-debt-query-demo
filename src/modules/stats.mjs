// 实时运营统计：按"日期 × 渠道 × 指标"计数（F08）。属于非关键路径——写失败直接忽略（有损服务），不影响主流程。
import {redis, key} from '../infra/redis.mjs';

export const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); // 北京时间日期
export const cleanChannel = raw => (typeof raw === 'string' && /^[a-z0-9_-]{1,32}$/i.test(raw) ? raw.toLowerCase() : 'direct');
export function bump(metric, channel = 'direct', by = 1) {
  redis.hincrby(key('stat', today()), channel + '|' + metric, by).catch(() => {});
}
export const FUNNEL = ['session', 'verified', 'verify_fail', 'query', 'outcome_own', 'outcome_history', 'outcome_candidate', 'outcome_empty', 'order_created', 'order_paid', 'callback_created', 'callback_withdrawn'];
