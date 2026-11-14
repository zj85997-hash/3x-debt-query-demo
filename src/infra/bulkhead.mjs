// 舱壁（并发隔离）：给每个下游依赖设"最多同时进行 N 个、最多排队 M 个、最多等 T 毫秒"。
// 超出即快速失败，保证慢依赖不会把整个进程的请求都拖住——这是防雪崩的第一道闸。
import {BusyError} from '../errors.mjs';
import {gauge, inc} from './metrics.mjs';

export class Bulkhead {
  constructor({name, maxConcurrent, maxQueue, queueWaitMs}) {
    Object.assign(this, {name, maxConcurrent, maxQueue, queueWaitMs});
    this.active = 0;
    this.queue = [];
    this.queued = 0;
    gauge(`bulkhead_active|${name}`, () => this.active);
    gauge(`bulkhead_queued|${name}`, () => this.queued);
  }
  async run(fn) {
    if (this.active >= this.maxConcurrent) await this.#wait();
    else this.active++;
    try { return await fn(); } finally { this.#release(); }
  }
  #wait() {
    if (this.queued >= this.maxQueue) {
      inc('bulkhead_rejected', this.name + ',queue_full');
      return Promise.reject(new BusyError(this.name, 'queue_full'));
    }
    // 下游长时间停顿时，已超时的等待者会留在数组里，这里定期清理，避免数组无限增长
    if (this.queue.length > this.maxQueue * 2 + 64) this.queue = this.queue.filter(w => !w.cancelled);
    return new Promise((resolve, reject) => {
      const waiter = {resolve, cancelled: false, timer: null};
      waiter.timer = setTimeout(() => {
        waiter.cancelled = true;
        this.queued--;
        inc('bulkhead_rejected', this.name + ',wait_timeout');
        reject(new BusyError(this.name, 'wait_timeout'));
      }, this.queueWaitMs);
      this.queue.push(waiter);
      this.queued++;
    });
  }
  #release() {
    while (this.queue.length) {
      const waiter = this.queue.shift();
      if (waiter.cancelled) continue;
      clearTimeout(waiter.timer);
      this.queued--;
      waiter.resolve();     // 名额直接移交给排队者，active 不变
      return;
    }
    this.active--;
  }
}
