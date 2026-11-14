// V2 · 容量摸高专用：每个虚拟用户先完成一次核验（不计入指标），然后不间断地反复查询。
// 只在"放开查询限流、关闭结果缓存"的专用实例上运行（见 bench/plans/v2-capacity.mjs），用来量出查询链路（API + MySQL + 审计流水）的上限。
import {getMeta, ipOf, pickPerson} from './common.mjs';

export async function setup(vu) {
  const meta = await getMeta(vu);
  const person = pickPerson(vu, 1);
  const headers = {'X-Forwarded-For': ipOf(vu, 1)};
  for (let attempt = 0; attempt < 20 && !vu.state.token; attempt++) {
    const session = await vu.request('_setup', 'POST', '/api/v1/session', {body: {channel: 'capacity'}, headers});
    const verified = session.body?.token && await vu.request('_setup', 'POST', '/api/v1/verify', {token: session.body.token, headers,
      body: {name: person.name, idNo: person.idNo, consent: {policyVersion: meta.policy.version, accepted: true}}});
    vu.state.token = verified?.body?.token;
    vu.state.kind = person.kind;
    if (!vu.state.token) await vu.sleep(500 + Math.random() * 1000);
  }
  if (!vu.state.token) throw new Error('预置核验失败');
}
export async function iteration(vu) {
  const r = await vu.request('query', 'POST', '/api/v1/query', {token: vu.state.token, body: {}, ok: r => r.status === 200 && r.body?.state === vu.state.kind,
    soft: r => r.status === 503 || r.status === 429});
  // 被告知"忙"时按服务端建议等待后再试（上限 1 秒，比建议值更激进）。不等待直接狂刷的客户端属于滥用，由滥用测试覆盖
  if (r.soft) await vu.sleep(Math.min(1000, r.body?.retryAfterMs || 500));
}
