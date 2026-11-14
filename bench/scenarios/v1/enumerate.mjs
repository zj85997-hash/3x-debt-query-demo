// V1 基线 · 枚举攻击模拟：单个会话遍历某姓名的全部证件尾号（0000–9999）
import {getPolicy, login} from './common.mjs';
let policy, tokenPromise, cursor = 0;
export async function setup(vu) {
  policy = await getPolicy(vu);
  vu.state.token = await (tokenPromise ??= login(vu, 'candidate'));
}
export async function iteration(vu) {
  const n = cursor++;
  if (n >= Math.ceil(10000 / vu.params.threads)) { await vu.sleep(100); return; }
  const tail4 = String((n * vu.params.threads + vu.id % vu.params.threads) % 10000).padStart(4, '0');
  // 攻击者视角：返回 200 即视为一次成功探测；命中另计
  const r = await vu.request('enumerate', 'POST', '/api/candidate-search', {token: vu.state.token, body: {accepted: true, policy, name: '样例甲', tail4}, ok: r => r.status === 200});
  if (r.ok && r.body.state !== 'empty') await vu.request('_hit', 'GET', '/livez');
}
