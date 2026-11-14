// 密码学工具：证件号盲索引、会话令牌签名、支付回调验签。
// 设计要点：平台不保存明文证件号。匹配用"带密钥的哈希"（HMAC-SHA256）：
//   · 证件号取值空间有限，普通哈希可被穷举反推，必须加密钥；
//   · 密钥由 KMS 托管，泄露数据库本身无法还原证件号。
import {createHmac, timingSafeEqual, randomBytes} from 'node:crypto';
import {config} from '../config.mjs';

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const {idHashKey, tokenSecret, payNotifySecret} = config.security;

/** 证件号盲索引（32 字节），用于台账与转让记录的精确匹配 */
export const idHash = idNo => hmac(idHashKey, 'id:' + idNo);
/** 姓名 + 证件末四位的组合索引，用于脱敏公告候选匹配 */
export const pairHash = (name, tail4) => hmac(idHashKey, 'pair:' + name + '|' + tail4);
/** 对外使用的用户假名编号（16 字符）。同一人始终相同，但无法反推证件号 */
export const subjectOf = idNo => hmac(idHashKey, 'sub:' + idNo).subarray(0, 12).toString('base64url');
/** 核验结果缓存键：姓名与证件号的组合指纹 */
export const proofKey = (name, idNo) => hmac(idHashKey, 'proof:' + name + '|' + idNo).subarray(0, 18).toString('base64url');
/** IP 等标识做限流键之前先哈希，避免在 Redis 中留存原值 */
export const shortHash = value => hmac(idHashKey, 'rl:' + value).subarray(0, 9).toString('base64url');

export const maskName = name => [...name][0] + '*'.repeat(Math.max(1, [...name].length - 1));
export const maskId = idNo => idNo.slice(0, 6) + '********' + idNo.slice(-4);

// ── 会话令牌：v1.<载荷>.<签名>。无状态校验，不依赖 Redis/数据库，任何实例都能验证。
const sign = payload => hmac(tokenSecret, payload).toString('base64url');
export function mintToken(claims, ttlSec) {
  const payload = Buffer.from(JSON.stringify({...claims, exp: Math.floor(Date.now() / 1000) + ttlSec})).toString('base64url');
  return 'v1.' + payload + '.' + sign('v1.' + payload);
}
export function readToken(token) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const expected = Buffer.from(sign('v1.' + parts[1]));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch { return null; }
}

// ── 支付回调签名：HMAC(密钥, 时间戳.原始报文)，5 分钟内有效，防伪造与重放
export const signNotify = (timestamp, rawBody, key = payNotifySecret) => hmac(key, timestamp + '.' + rawBody).toString('hex');
export function verifyNotify(timestamp, rawBody, signature) {
  if (!/^\d{10,13}$/.test(String(timestamp)) || typeof signature !== 'string') return false;
  if (Math.abs(Date.now() - Number(timestamp)) > 300000) return false;
  const expected = Buffer.from(signNotify(timestamp, rawBody));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export const randomId = (bytes = 12) => randomBytes(bytes).toString('base64url');
