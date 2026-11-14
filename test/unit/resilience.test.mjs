import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {Bulkhead} from '../../src/infra/bulkhead.mjs';
import {Breaker} from '../../src/infra/breaker.mjs';
import {BusyError, CircuitOpenError} from '../../src/errors.mjs';

test('舱壁：并发不超上限，排队先到先得', async () => {
  const gate = new Bulkhead({name: 't1', maxConcurrent: 3, maxQueue: 100, queueWaitMs: 2000});
  let active = 0, peak = 0;
  const order = [];
  await Promise.all(Array.from({length: 30}, (_, i) => gate.run(async () => {
    peak = Math.max(peak, ++active);
    order.push(i);
    await sleep(5);
    active--;
  })));
  assert.equal(peak, 3);
  assert.deepEqual(order, Array.from({length: 30}, (_, i) => i));
  assert.equal(gate.active, 0);
  assert.equal(gate.queued, 0);
});
test('舱壁：排队满了立即拒绝', async () => {
  const gate = new Bulkhead({name: 't2', maxConcurrent: 1, maxQueue: 2, queueWaitMs: 2000});
  const hold = gate.run(() => sleep(60));
  const queued = [gate.run(() => 1), gate.run(() => 2)];
  await assert.rejects(gate.run(() => 3), error => error instanceof BusyError && error.reason === 'queue_full');
  await Promise.all([hold, ...queued]);
});
test('舱壁：等待超时即放弃，名额不泄漏', async () => {
  const gate = new Bulkhead({name: 't3', maxConcurrent: 1, maxQueue: 10, queueWaitMs: 30});
  const hold = gate.run(() => sleep(120));
  await assert.rejects(gate.run(() => 1), error => error instanceof BusyError && error.reason === 'wait_timeout');
  await hold;
  assert.equal(await gate.run(() => 'ok'), 'ok');     // 超时者不占名额，后来者正常通过
  assert.equal(gate.active, 0);
  assert.equal(gate.queued, 0);
});
test('舱壁：任务抛错也会释放名额', async () => {
  const gate = new Bulkhead({name: 't4', maxConcurrent: 1, maxQueue: 1, queueWaitMs: 100});
  await assert.rejects(gate.run(async () => { throw new Error('boom'); }));
  assert.equal(await gate.run(() => 'next'), 'next');
});

test('断路器：失败率达到阈值后跳闸，冷却期内直接拒绝', async () => {
  const breaker = new Breaker({name: 'b1', windowSize: 10, minCalls: 4, failureRate: 0.5, openMs: 80});
  const boom = () => breaker.exec(async () => { throw new Error('down'); });
  for (let i = 0; i < 4; i++) await assert.rejects(boom(), /down/);
  assert.equal(breaker.state, 'open');
  let called = false;
  await assert.rejects(breaker.exec(async () => { called = true; }), error => error instanceof CircuitOpenError);
  assert.equal(called, false, '跳闸期间不应调用下游');
});
test('断路器：冷却后放行一个探测，成功则闭合，失败则再次跳闸', async () => {
  const breaker = new Breaker({name: 'b2', windowSize: 10, minCalls: 2, failureRate: 0.5, openMs: 40});
  for (let i = 0; i < 2; i++) await assert.rejects(breaker.exec(async () => { throw new Error('down'); }));
  await sleep(50);
  await assert.rejects(breaker.exec(async () => { throw new Error('still down'); }), /still down/);
  assert.equal(breaker.state, 'open');
  await sleep(50);
  assert.equal(await breaker.exec(async () => 'ok'), 'ok');
  assert.equal(breaker.state, 'closed');
});
test('断路器：探测期间只放行一个请求', async () => {
  const breaker = new Breaker({name: 'b3', windowSize: 10, minCalls: 2, failureRate: 0.5, openMs: 30});
  for (let i = 0; i < 2; i++) await assert.rejects(breaker.exec(async () => { throw new Error('down'); }));
  await sleep(40);
  const probe = breaker.exec(() => sleep(30).then(() => 'ok'));
  await assert.rejects(breaker.exec(async () => 'second'), error => error instanceof CircuitOpenError);
  assert.equal(await probe, 'ok');
});
test('断路器：业务性错误不计入失败', async () => {
  const breaker = new Breaker({name: 'b4', windowSize: 10, minCalls: 2, failureRate: 0.5, openMs: 30, isFailure: error => error.infra === true});
  for (let i = 0; i < 20; i++) await assert.rejects(breaker.exec(async () => { throw new Error('duplicate key'); }));
  assert.equal(breaker.state, 'closed');
});
