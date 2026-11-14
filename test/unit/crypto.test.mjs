import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {idHash, pairHash, subjectOf, proofKey, maskName, maskId, mintToken, readToken, signNotify, verifyNotify} from '../../src/infra/crypto.mjs';

test('盲索引：确定、定长、不同输入不同输出、不含明文', () => {
  const a = idHash('990000197003020180'), b = idHash('990000197003020180'), c = idHash('990000197001010018');
  assert.equal(a.length, 32);
  assert.ok(a.equals(b));
  assert.ok(!a.equals(c));
  assert.ok(!a.toString('latin1').includes('990000197003020180'));
  assert.ok(!pairHash('周霞', '0180').equals(pairHash('周霞', '0181')));
  assert.equal(subjectOf('990000197003020180').length, 16);
  assert.notEqual(proofKey('周霞', '990000197003020180'), proofKey('周霜', '990000197003020180'));
});
test('掩码', () => {
  assert.equal(maskName('周霞'), '周*');
  assert.equal(maskName('欧阳娜娜'), '欧***');
  assert.equal(maskId('990000197003020180'), '990000********0180');
});
test('令牌：签发、读取、篡改、过期', () => {
  const token = mintToken({sid: 's1', lvl: 1, sub: 'abc'}, 60);
  const claims = readToken(token);
  assert.equal(claims.sub, 'abc');
  assert.equal(claims.lvl, 1);
  const [v, payload, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({...claims, sub: 'someone-else'})).toString('base64url');
  assert.equal(readToken(`${v}.${forged}.${sig}`), null);                 // 改内容
  assert.equal(readToken(`${v}.${payload}.${sig.slice(0, -2)}xx`), null); // 改签名
  assert.equal(readToken(mintToken({sid: 's1'}, -1)), null);              // 已过期
  assert.equal(readToken('not-a-token'), null);
  assert.equal(readToken(undefined), null);
  assert.equal(readToken('x'.repeat(2000)), null);
});
test('支付回调验签：正确通过，改报文/改签名/过期时间戳均拒绝', () => {
  const body = JSON.stringify({orderNo: '1234567890123', amountFen: 990});
  const now = String(Date.now());
  const signature = signNotify(now, body);
  assert.ok(verifyNotify(now, body, signature));
  assert.equal(verifyNotify(now, body.replace('990', '1'), signature), false);
  assert.equal(verifyNotify(now, body, signature.replace(/^./, c => (c === 'a' ? 'b' : 'a'))), false);
  const old = String(Date.now() - 600000);
  assert.equal(verifyNotify(old, body, signNotify(old, body)), false);    // 重放 10 分钟前的通知
  assert.equal(verifyNotify('abc', body, signature), false);
  assert.equal(verifyNotify(now, body, undefined), false);
});
