// 趋势递增的 64 位编号（雪花算法）：41 位毫秒时间戳 | 10 位节点号 | 12 位序列。
// 作为主键时新数据总是追加在索引末尾，避免随机主键（UUIDv4）造成的页分裂与缓冲池抖动。
const EPOCH = 1767225600000n; // 2026-01-01T00:00:00Z
let node = BigInt((process.pid ^ (Math.random() * 1024)) & 1023);
let last = 0n;
let seq = 0n;

export function setNode(n) { node = BigInt(Number(n) & 1023); }
export function getNode() { return Number(node); }

export function nextId() {
  let now = BigInt(Date.now());
  if (now < last) now = last;                 // 时钟回拨：沿用已发出的最大时间，保证不重复
  if (now === last) {
    seq = (seq + 1n) & 4095n;
    if (seq === 0n) now = last + 1n;          // 同一毫秒序列用尽：借用下一毫秒
  } else {
    seq = 0n;
  }
  last = now;
  return (((now - EPOCH) << 22n) | (node << 12n) | seq).toString();
}
/** 从编号还原生成时间（毫秒） */
export const idTime = id => Number((BigInt(id) >> 22n) + EPOCH);
export const isId = v => typeof v === 'string' && /^[1-9]\d{9,19}$/.test(v);
