// V2 滥用与枚举测试：站在攻击者的角度尝试"批量查别人"和"刷接口"，看系统放行了多少。
// 使用一个固定的来源 IP（203.0.113.x 为文档保留地址段），模拟攻击流量来自同一出口。
import {writeFile} from 'node:fs/promises';
import {randomInt} from 'node:crypto';
import {personOf, SEG} from '../../src/domain/synth.mjs';
import {base, sleep} from '../lib/stack.mjs';

const attackerIp = `203.0.113.${randomInt(1, 250)}`;
async function call(method, path, {body, token, ip = attackerIp} = {}) {
  const response = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(token ? {Authorization: 'Bearer ' + token} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
  let json = null;
  try { json = await response.json(); } catch { /* 忽略 */ }
  return {status: response.status, code: json?.code, body: json};
}
async function pool(items, limit, work) {
  const results = [];
  let cursor = 0;
  await Promise.all(Array.from({length: limit}, async () => { while (cursor < items.length) { const i = cursor++; results[i] = await work(items[i], i); } }));
  return results;
}
const tally = list => list.reduce((acc, r) => { const k = r.status === 200 ? '放行' : `${r.status} ${r.code || ''}`.trim(); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
const meta = (await call('GET', '/api/v1/meta')).body;
const consent = {policyVersion: meta.policy.version, accepted: true};
const victims = n => Array.from({length: n}, () => personOf(randomInt(SEG.own[0] + 100000, SEG.own[1])));   // 假设攻击者手里有一批"姓名 + 证件号"（撞库）
const cases = [];
const began = Date.now();

// 1. 旧版的枚举入口：任意姓名 + 证件尾号检索
{
  const tails = Array.from({length: 200}, (_, i) => String(i).padStart(4, '0'));
  const results = await pool(tails, 50, async tail4 => {
    const a = await call('POST', '/api/candidate-search', {body: {name: '样例甲', tail4, accepted: true}});
    return a.status === 404 ? call('POST', '/api/v1/candidate-search', {body: {name: '样例甲', tail4}}) : a;
  });
  cases.push({name: '遍历"姓名 + 证件尾号"（旧版 1 万次全部成功）', attempts: tails.length, allowed: results.filter(r => r.status === 200).length, outcome: tally(results), expect: '接口已不存在，放行 0 次'});
}
// 2. 同一个会话，拿一批撞库得到的身份逐个核验
{
  const session = (await call('POST', '/api/v1/session', {body: {}})).body.token;
  const list = victims(200);
  const results = [];
  for (const v of list) results.push(await call('POST', '/api/v1/verify', {token: session, body: {name: v.name, idNo: v.idNo, consent}}));
  cases.push({name: '单个会话批量核验 200 个身份', attempts: list.length, allowed: results.filter(r => r.status === 200).length, outcome: tally(results), expect: '最多放行 5 次（会话维度）'});
}
// 3. 每次换一个新会话，但出口 IP 不变
{
  const list = victims(500);
  const results = await pool(list, 20, async v => {
    const session = await call('POST', '/api/v1/session', {body: {}});
    if (session.status !== 200) return session;
    return call('POST', '/api/v1/verify', {token: session.body.token, body: {name: v.name, idNo: v.idNo, consent}});
  });
  cases.push({name: '不断换会话、同一出口 IP 核验 500 个身份', attempts: list.length, allowed: results.filter(r => r.status === 200).length, outcome: tally(results), expect: '被 IP 维度限制，放行远小于 500（默认每 IP 每 10 分钟 60 次，且领会话每分钟 30 次）'});
}
// 4. 一个已核验的账号反复查询（刷接口 / 重放）
{
  const ip = `203.0.113.${randomInt(1, 250)}`;
  const me = personOf(randomInt(SEG.empty[0] + 200000, SEG.empty[1]));
  const session = (await call('POST', '/api/v1/session', {body: {}, ip})).body.token;
  const token = (await call('POST', '/api/v1/verify', {token: session, ip, body: {name: me.name, idNo: me.idNo, consent}})).body.token;
  const results = await pool(Array.from({length: 1000}), 50, () => call('POST', '/api/v1/query', {token, ip, body: {}}));
  cases.push({name: '已核验账号连续查询 1000 次', attempts: 1000, allowed: results.filter(r => r.status === 200).length, outcome: tally(results), expect: '放行约 10 次（每人每分钟 10 次），且查到的始终只是本人'});
}
// 5. 分布式猜测：每次都换 IP 换会话，对着同一个证件号换姓名试
{
  const target = personOf(randomInt(SEG.own[0] + 100000, SEG.own[1]));
  const names = Array.from({length: 100}, (_, i) => personOf(700000 + i).name).filter(n => n !== target.name);
  const results = await pool(names, 10, async (name, i) => {
    const ip = `198.51.100.${1 + (i % 250)}`;
    const session = (await call('POST', '/api/v1/session', {body: {}, ip})).body.token;
    return call('POST', '/api/v1/verify', {token: session, ip, body: {name, idNo: target.idNo, consent}});
  });
  cases.push({name: `换 IP 换会话，对同一证件号猜 ${names.length} 个姓名`, attempts: names.length, allowed: results.filter(r => r.code === 'VERIFY_MISMATCH').length, outcome: tally(results), expect: '最多 10 次真正打到核验供应商（证件维度），其余直接拒绝'});
}
console.table(cases.map(c => ({场景: c.name, 尝试: c.attempts, 放行: c.allowed, 预期: c.expect})));
for (const c of cases) console.log(`${c.name}: ${JSON.stringify(c.outcome)}`);
const file = process.env.REPORT || 'bench/reports/v2-abuse.json';
await writeFile(file, JSON.stringify({date: new Date().toISOString(), target: 'V2', base, seconds: (Date.now() - began) / 1000, cases}, null, 2) + '\n');
console.log('滥用测试报告已写入 ' + file);
await sleep(0);
process.exit(0);
