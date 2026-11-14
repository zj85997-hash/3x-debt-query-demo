// V1 基线 · 只读查询（与旧压测脚本同口径：会话预先建好，只测两个查询接口）
import {src, getPolicy, login} from './common.mjs';
const kinds = ['own', 'history', 'candidate', 'empty', 'one', 'ambiguous'];
const pairs = {one: {name: '样例甲', tail4: '0067', state: 'candidate'}, ambiguous: {name: '样例重名', tail4: '8042', state: 'ambiguous'}};
let policy;
export async function setup(vu) {
  policy = await getPolicy(vu);
  vu.state.kind = kinds[vu.id % kinds.length];
  vu.state.token = await login(vu, pairs[vu.state.kind] ? 'candidate' : vu.state.kind);
}
export async function iteration(vu) {
  const {kind, token} = vu.state;
  const pair = pairs[kind];
  if (pair) {
    await vu.request('candidate-search', 'POST', '/api/candidate-search', {token, tag: src,
      body: {accepted: true, policy, name: pair.name, tail4: pair.tail4}, ok: r => r.status === 200 && r.body?.state === pair.state});
  } else {
    await vu.request('query', 'POST', '/api/query', {token, tag: src, body: {accepted: true, policy}, ok: r => r.status === 200 && r.body?.state === kind});
  }
}
