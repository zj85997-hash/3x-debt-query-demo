// V1 基线 · 完整用户旅程：登录 → 查询 →（历史转让则解锁）→ 预约 → 查看 → 撤回
import {src, getPolicy, login} from './common.mjs';
const kinds = ['own', 'history', 'candidate', 'empty'];
let policy;
export async function setup(vu) { policy = await getPolicy(vu); }
export async function iteration(vu) {
  const kind = kinds[(vu.id + (vu.state.round = (vu.state.round || 0) + 1)) % kinds.length];
  const token = await login(vu, kind, 'session');
  if (!token) return;
  await vu.think();
  const q = await vu.request('query', 'POST', '/api/query', {token, tag: src, body: {accepted: true, policy}, ok: r => r.status === 200 && r.body?.state === kind});
  if (!q.ok) return;
  const requestId = q.body.requestId;
  await vu.think();
  if (kind === 'history') {
    await vu.request('unlock', 'POST', '/api/unlock', {token, tag: src, body: {requestId, simulated: true}});
    await vu.think();
  }
  const booked = await vu.request('callback', 'POST', '/api/callback', {token, tag: src, body: {requestId, timeWindow: '09:00–12:00', contactAccepted: true}});
  await vu.request('callback-list', 'GET', '/api/callback', {token, tag: src});
  if (booked.body?.id) await vu.request('withdraw', 'POST', '/api/callback/withdraw', {token, tag: src, body: {id: booked.body.id}});
}
