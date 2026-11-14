// 接口验收测试的公共工具。测试对象是 npm run dev 启动的本机环境（只访问 127.0.0.1）。
import {readFile} from 'node:fs/promises';
import {createHmac, randomInt, randomUUID} from 'node:crypto';
import mysql from 'mysql2/promise';
import {SEG, PERSONAS, personOf} from '../../src/domain/synth.mjs';

const local = new URL('../../.local/v2/', import.meta.url);
export const env = JSON.parse(await readFile(new URL('pids.json', local), 'utf8').catch(() => { throw new Error('未找到本机环境，请先在另一个终端运行 npm run dev'); }));
const secrets = JSON.parse(await readFile(new URL('secrets.json', local), 'utf8'));
export const base = env.base;
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(base)) throw new Error('验收测试只允许访问本机环境');

export const newIp = () => `10.${randomInt(200, 250)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
export async function call(method, path, {body, token, headers = {}, ip, raw} = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {...(body !== undefined || raw !== undefined ? {'Content-Type': 'application/json'} : {}), ...(token ? {Authorization: 'Bearer ' + token} : {}), ...(ip ? {'X-Forwarded-For': ip} : {}), ...headers},
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return {status: response.status, body: json, text, headers: response.headers};
}
export const meta = (await call('GET', '/api/v1/meta')).body;
export const persona = id => PERSONAS.find(p => p.id === id);
/** 从指定人口分段里随机取一位"今天没被测试用过"的虚构身份 */
export function fresh(kind) {
  const ranges = {own: [60000, 400000], history: [405000, 450000], candidate: [450001, 450499], empty: [600000, 990000]};
  const [from, to] = ranges[kind] || SEG[kind];
  return personOf(randomInt(from, to));
}
/** 匿名会话 → 核验，返回 {token, ip, sessionToken, profile} */
export async function login(person, ip = newIp()) {
  const session = await call('POST', '/api/v1/session', {body: {channel: 'apitest'}, ip});
  const verified = await call('POST', '/api/v1/verify', {token: session.body.token, ip,
    body: {name: person.name, idNo: person.idNo, consent: {policyVersion: meta.policy.version, accepted: true}}});
  return {status: verified.status, body: verified.body, token: verified.body?.token, ip, sessionToken: session.body.token, profile: verified.body?.profile};
}
export const query = user => call('POST', '/api/v1/query', {token: user.token, ip: user.ip, body: {}});
export const idem = () => 'test-' + randomUUID();
/**
 * 找一位"有历史转让记录、且还没解锁过"的虚构用户并完成登录与查询。
 * 压测会让一部分人处于已解锁状态，所以这里抽到已解锁的就换一个人。
 */
export async function lockedHistoryUser() {
  for (let i = 0; i < 40; i++) {
    const person = fresh('history');
    const user = await login(person);
    const result = (await query(user)).body;
    if (result.state === 'history' && !result.transfers[0].unlocked) return {person, user, result};
  }
  throw new Error('连续 40 次都抽到已解锁的用户，请先运行 npm run dev:exec -- scripts/reset-activity.mjs 清空业务流水');
}
/** 以支付渠道的身份发送一条签名正确的回调 */
export function notify(payload, {timestamp = String(Date.now()), signature} = {}) {
  const raw = JSON.stringify(payload);
  return call('POST', '/api/v1/pay/notify', {raw, headers: {'X-Pay-Timestamp': timestamp, 'X-Pay-Signature': signature ?? createHmac('sha256', secrets.PAY_NOTIFY_SECRET).update(timestamp + '.' + raw).digest('hex')}});
}
export const ops = (method, path, body) => call(method, path, {body, headers: {'X-Ops-Token': env.opsToken}});
let connection;
export async function sql(text, args = []) {
  connection ??= await mysql.createConnection({socketPath: env.mysqlSock, user: 'root', database: 'debt_query', supportBigNumbers: true, bigNumberStrings: true, dateStrings: true});
  return (await connection.query(text, args))[0];
}
export const closeSql = async () => { await connection?.end(); connection = null; };
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check, timeoutMs = 5000) {
  const begin = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - begin > timeoutMs) return null;
    await sleep(100);
  }
}
