// 接口验收测试：对应 PRD 第 13 节验收用例 A01–A12（A11、A12 由故障演练与压测覆盖）以及安全用例。
// 运行：先 npm run dev，再另开终端 npm run test:api
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {base, env, meta, call, login, query, persona, fresh, newIp, idem, notify, ops, sql, closeSql, sleep, until, lockedHistoryUser} from './_client.mjs';

after(closeSql);
const policy = meta.policy.version;
const verifyBody = (person, extra = {}) => ({name: person.name, idNo: person.idNo, consent: {policyVersion: policy, accepted: true}, ...extra});

test('A01 自有授权资产：核验后命中台账，只展示授权字段和数据时点', async () => {
  const user = await login(persona('own'));
  assert.equal(user.status, 200);
  assert.match(user.profile.idMasked, /^990000\*{8}\d{3}[\dX]$/);
  const result = await query(user);
  assert.equal(result.status, 200);
  assert.equal(result.body.state, 'own');
  assert.equal(result.body.records.length, 1);
  assert.deepEqual(Object.keys(result.body.records[0]).sort(), ['asOf', 'balanceFen', 'holder', 'loanDate', 'originator', 'principalFen']);
  assert.ok(Number.isInteger(result.body.records[0].balanceFen));
  assert.ok(!JSON.stringify(result.body).includes(persona('own').idNo), '响应里不得出现完整证件号');
});

test('A07 同一人两笔债务分别展示，不合并', async () => {
  const result = await query(await login(persona('own-multi')));
  assert.equal(result.body.state, 'own');
  assert.equal(result.body.records.length, 2);
});

test('A02 单一公告线索：只提示待核实，不返回任何公告明细', async () => {
  const result = await query(await login(persona('candidate')));
  assert.equal(result.body.state, 'candidate');
  assert.equal(result.body.ambiguous, false);
  assert.deepEqual(Object.keys(result.body).sort(), ['ambiguous', 'profile', 'queryId', 'state']);
});

test('A03 同名同尾号：标记冲突，不任选其一，不泄露候选清单', async () => {
  const result = await query(await login(persona('ambiguous')));
  assert.equal(result.body.state, 'candidate');
  assert.equal(result.body.ambiguous, true);
  assert.equal(result.body.records, undefined);
  assert.equal(result.body.transfers, undefined);
});

test('A04 无记录 与 A09 委托到期：都不展示资产，且委托到期的台账不会被当成在催资产', async () => {
  assert.equal((await query(await login(persona('empty')))).body.state, 'empty');
  const expired = await query(await login(persona('expired')));
  assert.equal(expired.body.state, 'empty');
  assert.equal(expired.body.records, undefined);
});

test('F02 核验的拒绝路径：未同意、文本版本过期、格式错误、真实证件号、姓名不符', async () => {
  const ip = newIp();
  const session = (await call('POST', '/api/v1/session', {body: {}, ip})).body.token;
  const attempt = body => call('POST', '/api/v1/verify', {token: session, ip, body});
  const own = persona('own');
  assert.equal((await attempt({...verifyBody(own), consent: {policyVersion: policy, accepted: false}})).body.code, 'CONSENT_REQUIRED');
  assert.equal((await attempt({...verifyBody(own), consent: {policyVersion: 'old-version', accepted: true}})).body.code, 'POLICY_OUTDATED');
  assert.equal((await attempt(verifyBody({name: own.name, idNo: own.idNo.slice(0, 17) + (own.idNo[17] === '1' ? '2' : '1')}))).body.code, 'ID_FORMAT');
  assert.equal((await attempt(verifyBody({name: 'Zhang San', idNo: own.idNo}))).body.code, 'NAME_FORMAT');
  // 演示环境的硬边界：格式完全正确的"真实地区码"证件号也不会被处理
  assert.equal((await attempt(verifyBody({name: '张三', idNo: '11010519491231002X'}))).body.code, 'DEMO_ID_ONLY');
  const mismatch = await call('POST', '/api/v1/verify', {token: (await call('POST', '/api/v1/session', {body: {}, ip: newIp()})).body.token, ip: newIp(), body: verifyBody(persona('mismatch'))});
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.body.code, 'VERIFY_MISMATCH');
  assert.equal(mismatch.body.token, undefined);
});

test('令牌：无令牌、匿名令牌、被篡改的令牌都不能查询', async () => {
  assert.equal((await call('POST', '/api/v1/query', {body: {}})).body.code, 'UNAUTHENTICATED');
  const anonymous = (await call('POST', '/api/v1/session', {body: {}, ip: newIp()})).body.token;
  assert.equal((await call('POST', '/api/v1/query', {token: anonymous, body: {}})).body.code, 'VERIFY_REQUIRED');
  const user = await login(persona('own'));
  const [v, payload, signature] = user.token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const forged = Buffer.from(JSON.stringify({...claims, sub: 'AAAAAAAAAAAAAAAA'})).toString('base64url');
  assert.equal((await call('POST', '/api/v1/query', {token: `${v}.${forged}.${signature}`, body: {}})).status, 401);
  assert.equal((await call('POST', '/api/v1/query', {token: user.token + 'x', body: {}})).status, 401);
});

test('查询接口不接受任何身份参数：无法替别人查（结构性防枚举）', async () => {
  const user = await login(persona('empty'));
  const other = persona('own');
  const attempt = await call('POST', '/api/v1/query', {token: user.token, ip: user.ip, body: {name: other.name, idNo: other.idNo}});
  assert.equal(attempt.status, 200);
  assert.equal(attempt.body.state, 'empty', '请求体里塞别人的身份不起任何作用，结果仍然是本人的');
  assert.equal((await call('POST', '/api/v1/candidate-search', {token: user.token, body: {name: other.name, tail4: other.idNo.slice(-4)}})).status, 404, '旧版的任意姓名+尾号检索接口已不存在');
});

test('F05 付费解锁全流程：未解锁读不到详情 → 下单幂等 → 支付回调 → 订单已支付 → 读到 6 项信息', async () => {
  const {user, result: found} = await lockedHistoryUser();
  const result = {body: found};
  const transfer = result.body.transfers[0];
  assert.deepEqual(Object.keys(transfer).sort(), ['amountFen', 'recordId', 'transferDate', 'unlocked'], '免费部分只有转让日期与金额');
  assert.equal((await call('GET', '/api/v1/records/' + transfer.recordId, {token: user.token})).status, 404);

  const key = idem();
  const order = await call('POST', '/api/v1/unlock/orders', {token: user.token, body: {queryId: result.body.queryId, recordId: transfer.recordId}, headers: {'Idempotency-Key': key}});
  assert.equal(order.status, 200);
  assert.equal(order.body.amountFen, meta.unlock.priceFen);
  assert.equal(order.body.status, 'created');
  // 同一幂等键重复提交、以及换一个幂等键再点一次：都不会产生第二张待支付订单
  const repeats = await Promise.all([key, key, idem()].map(k => call('POST', '/api/v1/unlock/orders', {token: user.token, body: {queryId: result.body.queryId, recordId: transfer.recordId}, headers: {'Idempotency-Key': k}})));
  for (const repeat of repeats) assert.equal(repeat.body.orderNo, order.body.orderNo);
  assert.equal((await call('POST', '/api/v1/unlock/orders', {token: user.token, body: {queryId: result.body.queryId, recordId: transfer.recordId}})).status, 400, '缺少幂等键应被拒绝');

  assert.equal((await call('POST', `/api/v1/unlock/orders/${order.body.orderNo}/mock-pay`, {token: user.token, body: {}})).status, 200);
  const paid = await until(async () => { const s = await call('GET', '/api/v1/unlock/orders/' + order.body.orderNo, {token: user.token}); return s.body.status === 'paid' ? s : null; });
  assert.ok(paid, '订单应在 5 秒内变为已支付');
  const detail = await call('GET', '/api/v1/records/' + transfer.recordId, {token: user.token});
  assert.equal(detail.status, 200);
  for (const field of ['debtor', 'transferor', 'transferee', 'transferDate', 'amountFen', 'contact']) assert.ok(detail.body[field], '应包含 ' + field);
  assert.ok(detail.body.debtor.includes('*'), '欠款人信息保持掩码');
  // 已解锁后再次下单：直接告知已解锁，不重复收费；重新查询时该记录标记为已解锁
  const again = await call('POST', '/api/v1/unlock/orders', {token: user.token, body: {queryId: result.body.queryId, recordId: transfer.recordId}, headers: {'Idempotency-Key': idem()}});
  assert.equal(again.body.alreadyUnlocked, true);
  assert.equal((await query(user)).body.transfers[0].unlocked, true);
  const [counts] = await sql('SELECT COUNT(*) AS orders, SUM(status = 1) AS paid FROM unlock_orders WHERE record_id = ?', [transfer.recordId]);
  assert.equal(Number(counts.orders), 1);
  assert.equal(Number(counts.paid), 1);
});

test('支付回调：伪造签名 403、过期时间戳 403、金额不符 409、同一通知并发 6 次只生效一次', async () => {
  const {user, result: found} = await lockedHistoryUser();
  const result = {body: found};
  const transfer = result.body.transfers[0];
  const order = (await call('POST', '/api/v1/unlock/orders', {token: user.token, body: {queryId: result.body.queryId, recordId: transfer.recordId}, headers: {'Idempotency-Key': idem()}})).body;
  const payload = {orderNo: order.orderNo, txnId: 'TXNtest' + Date.now(), amountFen: order.amountFen, status: 'SUCCESS'};
  assert.equal((await notify(payload, {signature: 'deadbeef'})).status, 403);
  assert.equal((await notify(payload, {timestamp: String(Date.now() - 3600000)})).status, 403, '一小时前的通知视为重放');
  assert.equal((await notify({...payload, amountFen: 1})).status, 409, '金额与订单不符必须拒绝');
  assert.equal((await call('GET', '/api/v1/unlock/orders/' + order.orderNo, {token: user.token})).body.status, 'created', '以上三次都不应改变订单');

  const outcomes = (await Promise.all(Array.from({length: 6}, () => notify(payload)))).map(r => r.body?.outcome);
  assert.equal(outcomes.filter(o => o === 'paid').length, 1, '只有一次真正把订单置为已支付');
  assert.equal(outcomes.filter(o => o === 'duplicate').length, 5, '其余五次识别为重复通知并成功应答');
  const [row] = await sql('SELECT (SELECT COUNT(*) FROM unlock_grants WHERE order_no = ?) AS grants, (SELECT status FROM unlock_orders WHERE order_no = ?) AS status', [order.orderNo, order.orderNo]);
  assert.equal(Number(row.grants), 1);
  assert.equal(Number(row.status), 1);
});

test('A06 越权：别人的查询编号、订单号、记录号、预约号，一律拿不到也改不了', async () => {
  const {user: owner, result: ownerResult} = await lockedHistoryUser();
  const recordId = ownerResult.transfers[0].recordId;
  const order = (await call('POST', '/api/v1/unlock/orders', {token: owner.token, body: {queryId: ownerResult.queryId, recordId}, headers: {'Idempotency-Key': idem()}})).body;
  const ticket = (await call('POST', '/api/v1/callbacks', {token: owner.token, body: {queryId: ownerResult.queryId, timeWindow: meta.callbackWindows[0], contactConsent: true}})).body;

  const {user: intruder, result: intruderResult} = await lockedHistoryUser();
  const as = (method, path, body, headers) => call(method, path, {token: intruder.token, body, headers});
  assert.equal((await as('GET', '/api/v1/unlock/orders/' + order.orderNo)).status, 404);
  assert.equal((await as('POST', `/api/v1/unlock/orders/${order.orderNo}/mock-pay`, {})).status, 404);
  assert.equal((await as('GET', '/api/v1/records/' + recordId)).status, 404);
  // 用别人的查询编号下单 / 预约；用自己的查询编号去解锁别人的记录
  assert.equal((await as('POST', '/api/v1/unlock/orders', {queryId: ownerResult.queryId, recordId}, {'Idempotency-Key': idem()})).status, 404);
  assert.equal((await as('POST', '/api/v1/unlock/orders', {queryId: intruderResult.queryId, recordId}, {'Idempotency-Key': idem()})).status, 404);
  assert.equal((await as('POST', '/api/v1/callbacks', {queryId: ownerResult.queryId, timeWindow: meta.callbackWindows[0], contactConsent: true})).status, 404);
  assert.equal((await as('POST', `/api/v1/callbacks/${ticket.id}/withdraw`, {})).status, 404);
  assert.equal((await as('GET', '/api/v1/callbacks')).body.tickets.length, 0, '看不到别人的预约');
  assert.equal((await call('GET', '/api/v1/callbacks', {token: owner.token})).body.tickets[0].status, 'pending', '原主人的预约不受影响');
});

test('F06 预约与 A10 撤回：必须单独同意；同一查询并发提交只有一条；撤回后联系授权同时失效', async () => {
  const person = fresh('own');
  const user = await login(person);
  const result = (await query(user)).body;
  const body = {queryId: result.queryId, timeWindow: meta.callbackWindows[1], contactConsent: true};
  assert.equal((await call('POST', '/api/v1/callbacks', {token: user.token, body: {...body, contactConsent: false}})).body.code, 'CONSENT_REQUIRED');
  assert.equal((await call('POST', '/api/v1/callbacks', {token: user.token, body: {...body, timeWindow: '随便什么时候'}})).status, 400);
  const burst = await Promise.all(Array.from({length: 5}, () => call('POST', '/api/v1/callbacks', {token: user.token, body})));
  assert.deepEqual(burst.map(r => r.status).sort(), [200, 200, 200, 200, 201]);
  assert.equal(new Set(burst.map(r => r.body.id)).size, 1);
  const id = burst[0].body.id;
  const [granted] = await sql("SELECT withdrawn_at FROM consents WHERE ref_id = ? AND kind = 'contact'", [id]);
  assert.equal(granted.withdrawn_at, null);
  assert.equal((await call('POST', `/api/v1/callbacks/${id}/withdraw`, {token: user.token, body: {}})).body.status, 'withdrawn');
  assert.equal((await call('POST', `/api/v1/callbacks/${id}/withdraw`, {token: user.token, body: {}})).status, 404, '已撤回的不能重复撤回');
  const [withdrawn] = await sql("SELECT withdrawn_at FROM consents WHERE ref_id = ? AND kind = 'contact'", [id]);
  assert.ok(withdrawn.withdrawn_at, '撤回预约必须同时记录联系授权的撤回时间');
  // 换一个会话（比如换了手机）用同一身份登录，仍能看到自己的预约记录
  const relogin = await login(person);
  assert.equal((await call('GET', '/api/v1/callbacks', {token: relogin.token})).body.tickets[0].id, id);
});

test('审计：每次成功查询恰好一条审计记录，库与日志里都没有姓名和证件号明文', async () => {
  const person = fresh('own');
  const user = await login(person);
  const result = (await query(user)).body;
  const row = await until(async () => (await sql('SELECT * FROM query_logs WHERE id = ?', [result.queryId]))[0]);
  assert.ok(row, '审计记录应在数秒内由后台进程落库');
  assert.equal(row.outcome, 'own');
  assert.equal(row.policy_version, policy);
  assert.equal(row.channel, 'apitest');
  assert.ok(!JSON.stringify(row).includes(person.idNo) && !JSON.stringify(row).includes(person.name));
  const [consent] = await sql("SELECT COUNT(*) AS n FROM consents WHERE sub = ? AND kind = 'query'", [row.sub]);
  assert.ok(Number(consent.n) >= 1, '查询前已有授权记录');
  const stored = await sql('SELECT name_masked, id_masked, HEX(id_hash) AS h FROM assets WHERE id_masked = ? LIMIT 5', [user.profile.idMasked]);
  assert.ok(stored.every(r => !r.h.includes(person.idNo) && r.id_masked.includes('********')), '台账只存掩码与盲索引');
  const log = await readFile(new URL('../../.local/v2/logs/app.log', import.meta.url), 'utf8');
  assert.ok(log.includes(`"id":"${result.queryId}"`), '审计日志通道里有这次查询');
  assert.ok(!log.includes(person.idNo), '日志里不得出现证件号');
  assert.ok(!log.includes(person.name), '日志里不得出现姓名');
});

test('限流：同一会话第 6 次核验被拒并给出等待时间；同一人一分钟内第 11 次查询被拒', async () => {
  const ip = newIp();
  const session = (await call('POST', '/api/v1/session', {body: {}, ip})).body.token;
  const own = persona('own');
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push(await call('POST', '/api/v1/verify', {token: session, ip, body: verifyBody(own)}));
  assert.deepEqual(statuses.slice(0, 5).map(r => r.status), [200, 200, 200, 200, 200]);
  assert.equal(statuses[5].status, 429);
  assert.equal(statuses[5].body.code, 'RATE_LIMITED');
  assert.ok(statuses[5].body.retryAfterMs > 0 && Number(statuses[5].headers.get('retry-after')) >= 1);

  const user = await login(fresh('empty'));
  const queries = [];
  for (let i = 0; i < 11; i++) queries.push((await query(user)).status);
  assert.deepEqual(queries.slice(0, 10), Array(10).fill(200));
  assert.equal(queries[10], 429);
});

test('限流：同一个证件号换着姓名试，超过 10 次即被封到第二天（猜不出"谁的证件"）', async () => {
  const victim = fresh('empty');
  const names = ['赵一', '钱二', '孙三', '李四', '周五', '吴六', '郑七', '王八', '冯九', '陈十', '褚十一', '卫十二'];
  const codes = [];
  for (const name of names) {       // 每次都换新会话、新 IP，绕开会话与 IP 维度，专测证件维度
    const ip = newIp();
    const session = (await call('POST', '/api/v1/session', {body: {}, ip})).body.token;
    codes.push((await call('POST', '/api/v1/verify', {token: session, ip, body: verifyBody({name, idNo: victim.idNo})})).body.code);
  }
  assert.deepEqual(codes.slice(0, 10), Array(10).fill('VERIFY_MISMATCH'));
  assert.deepEqual(codes.slice(10), ['RATE_LIMITED', 'RATE_LIMITED']);
});

test('输入校验：多余字段、非法 JSON、超大报文、缺少必填项、路径参数注入', async () => {
  const session = (await call('POST', '/api/v1/session', {body: {}, ip: newIp()})).body.token;
  assert.equal((await call('POST', '/api/v1/verify', {token: session, body: verifyBody(persona('own'), {isAdmin: true})})).status, 400);
  assert.equal((await call('POST', '/api/v1/verify', {token: session, raw: '{"name": '})).status, 400);
  assert.equal((await call('POST', '/api/v1/verify', {token: session, raw: JSON.stringify({name: 'x'.repeat(20000)})})).status, 413);
  assert.equal((await call('POST', '/api/v1/verify', {token: session, body: {name: '张三'}})).status, 400);
  const user = await login(persona('own'));
  for (const bad of ["1' OR '1'='1", '../../etc/passwd', '12345', '99999999999999999999999999']) {
    const response = await call('GET', '/api/v1/unlock/orders/' + encodeURIComponent(bad), {token: user.token});
    assert.ok([400, 404].includes(response.status), `非法订单号 ${bad} 应被拒绝`);
  }
  assert.equal((await call('GET', '/api/v1/does-not-exist')).status, 404);
});

test('动态开关：关闭付费解锁后下单被拒，恢复后可用；运营接口必须带令牌', async () => {
  assert.equal((await call('POST', '/ops/api/flags', {body: {name: 'unlock_off', value: true}})).status, 403);
  assert.equal((await ops('POST', '/ops/api/flags', {name: 'no_such_flag', value: true})).status, 400);
  const {user, result} = await lockedHistoryUser();
  const order = () => call('POST', '/api/v1/unlock/orders', {token: user.token, body: {queryId: result.queryId, recordId: result.transfers[0].recordId}, headers: {'Idempotency-Key': idem()}});
  try {
    assert.equal((await ops('POST', '/ops/api/flags', {name: 'unlock_off', value: true})).status, 200);
    // 发布订阅即时广播：连续 8 次请求（会分散到不同进程）都应被拒绝
    await sleep(300);
    const attempts = await Promise.all(Array.from({length: 8}, () => order()));
    assert.ok(attempts.every(r => r.body.code === 'FEATURE_DISABLED'), '开关应即时对所有进程生效：' + JSON.stringify(attempts.map(r => r.body.code)));
    const blocked = attempts[0];
    assert.equal(blocked.status, 503);
    assert.equal((await query(user)).status, 200, '关闭解锁不影响查询');
  } finally {
    await ops('POST', '/ops/api/flags', {name: 'unlock_off', value: false});
    await sleep(2500);   // 等过轮询兜底周期，确保所有进程都已恢复，不影响后续用例
  }
  assert.ok(await until(async () => ((await order()).status === 200 ? true : null), 6000), '恢复后可以正常下单');
});

test('运营与监控接口：汇总数据来自全部进程；/metrics 输出 Prometheus 文本', async () => {
  assert.equal((await call('GET', '/ops/api/overview')).status, 403);
  assert.equal((await call('GET', '/metrics')).status, 403);
  const overview = (await ops('GET', '/ops/api/overview')).body;
  assert.ok(overview.instances.filter(i => i.role === 'api').length >= 2, '至少两个 API 进程在汇报');
  assert.ok(overview.instances.some(i => i.role === 'worker'), '后台进程在汇报');
  assert.equal(overview.degraded, false);
  const metrics = await call('GET', '/metrics', {headers: {Authorization: 'Bearer ' + env.opsToken}});
  assert.equal(metrics.status, 200);
  assert.match(metrics.text, /dq_http_requests_total\{instance="[^"]+",role="api",label="POST \/api\/v1\/query,200"\} \d+/);
  assert.match(metrics.text, /dq_http_ms_bucket\{[^}]*le="\+Inf"\} \d+/);
});

test('健康检查与静态页面：就绪检查不依赖数据库；页面带安全响应头并支持 304', async () => {
  assert.deepEqual((await call('GET', '/healthz')).body, {ok: true});
  assert.equal((await call('GET', '/readyz')).body.ok, true);
  assert.equal((await call('GET', '/healthz/deps')).status, 403, '依赖详情不对外公开');
  const deps = (await ops('GET', '/healthz/deps')).body;
  assert.equal(deps.mysql, 'closed');
  assert.equal(deps.redis, 'ready');
  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(!page.text.includes('style='), '页面不使用内联样式');
  const cached = await call('GET', '/', {headers: {'If-None-Match': page.headers.get('etag')}});
  assert.equal(cached.status, 304);
  assert.equal((await call('GET', '/assets/..%2f..%2fpackage.json')).status, 404, '静态目录不能越级读取');
  assert.ok((await call('GET', '/api/v1/meta')).headers.get('x-request-id'), '每个响应都带请求编号');
  assert.equal(base.startsWith('http://127.0.0.1'), true);
  await sleep(0);
});
