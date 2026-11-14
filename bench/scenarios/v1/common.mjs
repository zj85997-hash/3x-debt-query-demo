// V1 基线场景公共函数
export const src = r => (r.headers['x-demo-instance'] ? 'api' : 'gateway');
let policyPromise;
// 等待服务可用后取授权版本（旧系统在过载后需要时间恢复，这里最多等 30 秒）
export function getPolicy(vu) {
  return policyPromise ??= (async () => {
    for (let i = 0; i < 150; i++) {
      const r = await vu.request('_setup', 'GET', '/api/profiles');
      if (r.body?.policy) return r.body.policy;
      await vu.sleep(200);
    }
    throw Error('服务 30 秒内未恢复');
  })();
}
export async function login(vu, profile, metric = '_setup') {
  for (let i = 0; i < 150; i++) {
    const r = await vu.request(metric, 'POST', '/api/session', {body: {profile}});
    if (r.body?.token) return r.body.token;
    if (metric !== '_setup') return null;
    await vu.sleep(200);
  }
  throw Error('登录 30 秒内未恢复');
}
