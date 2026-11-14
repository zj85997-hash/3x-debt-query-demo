import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {nextId, idTime, isId, setNode} from '../../src/infra/ids.mjs';

test('编号：唯一、严格递增、可还原时间', () => {
  setNode(7);
  const seen = new Set();
  let previous = 0n;
  for (let i = 0; i < 200000; i++) {
    const id = nextId();
    assert.ok(BigInt(id) > previous, '后生成的编号必须更大');
    previous = BigInt(id);
    seen.add(id);
  }
  assert.equal(seen.size, 200000);
  assert.ok(Math.abs(idTime(nextId()) - Date.now()) < 2000);
});
test('不同节点号在同一毫秒也不冲突', () => {
  setNode(1);
  const a = nextId();
  setNode(2);
  const b = nextId();
  assert.notEqual(a, b);
});
test('编号格式校验', () => {
  assert.ok(isId(nextId()));
  assert.equal(isId('123'), false);
  assert.equal(isId('12345678901234567890123'), false);
  assert.equal(isId("1' OR '1'='1"), false);
  assert.equal(isId(1234567890123), false);
});
