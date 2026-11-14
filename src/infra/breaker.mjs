// 断路器：下游连续出错时"跳闸"，在冷却期内直接拒绝，不再让请求白白等待超时；
// 冷却后放行少量探测请求，成功则恢复。状态：closed（正常）→ open（跳闸）→ half（探测）→ closed。
import {CircuitOpenError} from '../errors.mjs';
import {gauge, inc} from './metrics.mjs';

export class Breaker {
  constructor({name, windowSize = 20, minCalls = 10, failureRate = 0.5, openMs = 2000, isFailure = () => true}) {
    Object.assign(this, {name, windowSize, minCalls, failureRate, openMs, isFailure});
    this.state = 'closed';
    this.ring = [];          // 最近 windowSize 次调用的成败（1=失败）
    this.failures = 0;
    this.openedAt = 0;
    this.probing = false;
    gauge(`breaker_open|${name}`, () => (this.state === 'closed' ? 0 : 1));
  }
  async exec(fn) {
    if (this.state === 'open') {
      const waited = Date.now() - this.openedAt;
      if (waited < this.openMs) { inc('breaker_rejected', this.name); throw new CircuitOpenError(this.name, this.openMs - waited); }
      this.state = 'half';
      this.probing = false;
    }
    if (this.state === 'half') {
      if (this.probing) { inc('breaker_rejected', this.name); throw new CircuitOpenError(this.name, 500); }
      this.probing = true;
    }
    try {
      const result = await fn();
      this.#record(false);
      return result;
    } catch (error) {
      this.#record(this.isFailure(error));
      throw error;
    }
  }
  #record(failed) {
    if (this.state === 'half') {
      this.probing = false;
      if (failed) this.#open(); else this.#close();
      return;
    }
    this.ring.push(failed ? 1 : 0);
    if (failed) this.failures++;
    if (this.ring.length > this.windowSize) this.failures -= this.ring.shift();
    if (this.ring.length >= this.minCalls && this.failures / this.ring.length >= this.failureRate) this.#open();
  }
  #open() {
    if (this.state !== 'open') inc('breaker_opened', this.name);
    this.state = 'open';
    this.openedAt = Date.now();
    this.ring = [];
    this.failures = 0;
  }
  #close() {
    this.state = 'closed';
    this.ring = [];
    this.failures = 0;
  }
}
