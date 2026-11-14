// V2 压测场景公共部分：虚拟用户的行为尽量贴近真实用户与真实前端——
//   · 每个虚拟用户来自不同的 IP（X-Forwarded-For），每一轮都换一个新的虚构身份（最坏情况：全是新用户，核验缓存不命中）
//   · 服务端回"忙"（503 + 建议等待时间）时，按建议时间等待后重试，与 H5 前端的策略一致
import {personOf, SEG} from '../../../src/domain/synth.mjs';

const BUSY = new Set(['VERIFY_BUSY', 'VERIFY_UNAVAILABLE', 'SERVER_BUSY', 'QUERY_UNAVAILABLE', 'PAY_UNAVAILABLE']);
export const isBusy = r => r.status === 503 && BUSY.has(r.body?.code);
export const isLimited = r => r.status === 429;
const runSalt = (Date.now() ^ (process.pid << 12)) >>> 0;
// 均匀散列：让每一轮旅程在目标人群里"随机抽一个人"，不同批次的压测之间只有生日悖论级别的少量重合
function mix(a, b, c) {
  let x = (a ^ Math.imul(b + 1, 0x9e3779b1) ^ Math.imul(c + 1, 0x85ebca6b)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}
let metaPromise;

export function getMeta(vu) {
  return metaPromise ??= (async () => {
    for (let i = 0; i < 100; i++) {
      const r = await vu.request('_setup', 'GET', '/api/v1/meta');
      if (r.body?.policy) return r.body;
      await vu.sleep(300);
    }
    throw new Error('服务未就绪');
  })();
}
// 每一轮旅程代表"一位新来的用户"，所以来源 IP 也随之变化（同一个人不会在几分钟内反复核验几十次）。
// 这样建模的是"同一时刻有 N 人在用，用完离开、新人进来"，而不是"固定 N 个人无限循环"。
export function ipOf(vu, round = 0) {
  const n = mix(runSalt ^ 0x5bd1e995, vu.id, round);
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

/** 按比例挑一个身份：60% 自有资产、20% 历史转让、10% 公告候选、10% 无记录；同一次压测内基本不重复 */
export function pickPerson(vu, round) {
  const roll = (vu.id + round * 3) % 10;
  const kind = roll < 6 ? 'own' : roll < 8 ? 'history' : roll < 9 ? 'candidate' : 'empty';
  const [from, to] = SEG[kind];
  return {kind, ...personOf(from + mix(runSalt, vu.id, round) % (to - from))};
}

/**
 * 执行一步（一次业务动作）：遇到"忙"自动等待重试，最多 maxRetries 次。
 * 同时记录两层指标：HTTP 层（每次请求）与业务层（step:名称，含排队等待的总耗时）。
 */
export async function step(vu, name, method, path, options = {}, maxRetries = 8) {
  const begin = performance.now();
  for (let attempt = 0; ; attempt++) {
    const r = await vu.request(name, method, path, {...options, soft: res => isBusy(res) || (options.soft?.(res) ?? false)});
    if (r.ok) { vu.mark('step:' + name, performance.now() - begin, true); return r.body ?? {}; }
    // 与 H5 前端一致：服务端说"忙"、或网络层失败（连接被重置等）时等待后重试；所有接口都按幂等设计，重发是安全的
    if ((isBusy(r) || r.status === 0) && attempt < maxRetries) {
      await vu.sleep(Math.min(8000, (r.body?.retryAfterMs || 700) * (1 + attempt * 0.4)) + Math.random() * 300);
      continue;
    }
    vu.mark('step:' + name, performance.now() - begin, false, r.status ? r.status + ':' + (r.body?.code || '') : r.error);
    return null;
  }
}
