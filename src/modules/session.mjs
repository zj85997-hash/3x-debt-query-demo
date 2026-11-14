// 会话：进入页面先领一个匿名会话（小程序里对应 wx.login 换 openid），用于渠道归因和核验前的频率限制。
import {config} from '../config.mjs';
import {E} from '../errors.mjs';
import {mintToken, randomId, shortHash} from '../infra/crypto.mjs';
import {take} from '../infra/limiter.mjs';
import {flag} from '../infra/flags.mjs';
import {bump, cleanChannel} from './stats.mjs';

export async function openSession({ip, channel}) {
  if (flag('new_session_off')) throw E.serverBusy('当前访问人数较多，请稍后再进入', {retryAfterMs: 5000});
  const limit = await take([{key: 'session:ip:' + shortHash(ip), ...config.limits.sessionIp}]);
  if (!limit.allowed) throw E.rateLimited(null, {retryAfterMs: limit.retryAfterMs});
  const ch = cleanChannel(channel);
  bump('session', ch);
  return {token: mintToken({sid: randomId(), lvl: 0, ch}, config.session.anonTtlSec), expiresInSec: config.session.anonTtlSec};
}
