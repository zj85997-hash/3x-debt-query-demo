// 静态页面（H5 与运营大盘）。启动时读入内存并计算 ETag；正式环境建议改由对象存储 + CDN 分发。
import {readFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const ROOT = new URL('../../web/', import.meta.url);
const TYPES = {html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', json: 'application/json; charset=utf-8', png: 'image/png'};
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const live = process.env.STATIC_LIVE === '1';       // 开发时每次请求都重新读文件
const cache = new Map();

async function load(name) {
  const body = await readFile(new URL(name, ROOT));
  return {body, type: TYPES[name.split('.').pop()] || 'application/octet-stream', etag: '"' + createHash('sha1').update(body).digest('base64url').slice(0, 20) + '"'};
}
export async function preloadAssets() {
  for (const name of await readdir(ROOT)) if (/^[\w.-]+\.(html|css|js|svg|png)$/.test(name)) cache.set(name, await load(name));
}
export async function sendAsset(req, reply, name) {
  if (!/^[\w.-]+$/.test(name)) return reply.code(404).send({code: 'NOT_FOUND', message: '页面不存在'});
  let asset = cache.get(name);
  if (live || !asset) {
    try { asset = await load(name); cache.set(name, asset); } catch { return reply.code(404).send({code: 'NOT_FOUND', message: '页面不存在'}); }
  }
  reply.header('ETag', asset.etag).header('Cache-Control', 'no-cache').header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', CSP).header('Referrer-Policy', 'no-referrer');
  if (req.headers['if-none-match'] === asset.etag) return reply.code(304).send();
  return reply.type(asset.type).send(asset.body);
}
