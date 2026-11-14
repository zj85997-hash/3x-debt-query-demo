import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {isValidId} from '../../src/domain/idcard.mjs';
import {SEG, PERSONAS, personOf, idOf, nameOf, indexOfId, isSyntheticId, assetsOf, transfersOf, candidatesOf, segmentOf} from '../../src/domain/synth.mjs';

test('虚构证件号：格式合法、全部 99 开头、可逆', () => {
  const picks = [0, 1, 999, 1000, 60018, 399999, 400000, 449999, 450500, 461999, 462000, 999999];
  for (let i = 0; i < 2000; i++) picks.push(Math.floor(Math.random() * 1000000));
  for (const i of picks) {
    const id = idOf(i);
    assert.ok(isValidId(id), `编号 ${i} 的证件号应通过格式校验`);
    assert.ok(id.startsWith('99'));
    assert.equal(indexOfId(id), i);
  }
});
test('虚构证件号在抽样范围内不重复', () => {
  const seen = new Set();
  for (let i = 0; i < 200000; i++) seen.add(idOf(i));
  assert.equal(seen.size, 200000);
});
test('真实地区码的证件号不会被当成虚构身份', () => {
  assert.equal(isSyntheticId('11010519491231002X'), false);
  assert.equal(indexOfId('990000197001010019'), -1);   // 99 开头但校验码不对
});
test('人口分段与记录数量', () => {
  assert.equal(assetsOf(1).length, 2);                               // 一人两笔
  assert.equal(assetsOf(60018).length, 1);
  assert.equal(assetsOf(60018)[0].mandateStatus, 1);
  assert.equal(assetsOf(SEG.expired[0])[0].mandateStatus, 0);        // 委托到期
  assert.equal(transfersOf(400001).length, 2);
  assert.equal(transfersOf(420123).length, 1);
  assert.equal(candidatesOf(450500).length, 2);                      // 同名同尾号冲突
  assert.equal(candidatesOf(450001).length, 1);
  assert.equal(assetsOf(500000).length + transfersOf(500000).length + candidatesOf(500000).length, 0);
  assert.equal(segmentOf(500000), 'empty');
});
test('金额为正整数（分），本息不小于本金', () => {
  for (let i = 0; i < 5000; i += 7) for (const a of assetsOf(i)) {
    assert.ok(Number.isInteger(a.principalFen) && a.principalFen > 0);
    assert.ok(a.balanceFen >= a.principalFen);
  }
});
test('演示身份：9 张卡片，"核验不通过"的姓名确实对不上', () => {
  assert.equal(PERSONAS.length, 9);
  const mismatch = PERSONAS.find(p => p.id === 'mismatch');
  assert.notEqual(mismatch.name, nameOf(indexOfId(mismatch.idNo)));
  for (const p of PERSONAS.filter(p => p.id !== 'mismatch')) assert.equal(p.name, personOf(indexOfId(p.idNo)).name);
});
