// 小程序页面逻辑联调：在 Node 里用一个极简的 wx / Page 替身加载 mini/ 下的真实代码，对着本机服务走完整流程。
// 它验证的是"页面脚本 + 接口"的逻辑正确；界面渲染与真机表现仍需在微信开发者工具里确认。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {base, lockedHistoryUser} from './_client.mjs';

const root = new URL('../../mini/', import.meta.url);
const toasts = [];
const wx = {
  request({url, method, data, header, success, fail}) {
    fetch(url, {method, headers: header, body: data === undefined || method === 'GET' ? undefined : JSON.stringify(data)})
      .then(async response => success({statusCode: response.status, data: await response.json().catch(() => ({}))}), fail);
  },
  showToast: options => toasts.push(options.title)
};
function load(file, requireMap, extra = {}) {
  const module = {exports: {}};
  const context = vm.createContext({module, exports: module.exports, wx, console, setTimeout, Promise, Date, Math, Object, Number, Error,
    require: name => { if (!(name in requireMap)) throw new Error('unexpected require ' + name); return requireMap[name]; }, ...extra});
  vm.runInContext(readFileSync(new URL(file, root), 'utf8'), context, {filename: file});
  return module.exports;
}
function setPath(target, path, value) {
  const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) node = node[key];
  node[keys.at(-1)] = value;
}

test('小程序页面：核验 → 查询 → 付费解锁 → 预约 → 撤回 → 退出', async () => {
  const api = load('utils/api.js', {'../config': {baseUrl: base}});
  let definition;
  load('pages/index/index.js', {'../../utils/api': api}, {Page: value => { definition = value; }});
  const page = {...definition, data: structuredClone(definition.data), setData(patch) { for (const [k, v] of Object.entries(patch)) setPath(this.data, k, v); }};

  await page.onLoad({ch: 'mini-test'});
  assert.equal(page.data.ready, true);
  assert.equal(page.data.personas.length, 9);

  // 未同意授权时不能提交
  const {person} = await lockedHistoryUser();
  page.onName({detail: {value: person.name}});
  page.onIdNo({detail: {value: person.idNo.toLowerCase()}});
  await page.submit();
  assert.match(page.data.error, /同意/);

  page.onAccept({detail: {value: ['yes']}});
  await page.submit();
  assert.equal(page.data.error, '');
  assert.equal(page.data.step, 2);
  assert.equal(page.data.result.state, 'history');
  assert.equal(page.data.name, '', '提交成功后清空输入框里的姓名');
  assert.equal(page.data.idNo, '', '提交成功后清空输入框里的证件号');
  assert.ok(page.data.result.transfers[0].amountText.startsWith('¥'));
  assert.equal(page.data.result.transfers[0].detail, null);

  await page.unlock({currentTarget: {dataset: {i: 0}}});
  assert.ok(page.data.cashier, '应弹出收银台');
  assert.equal(page.data.cashier.amountText, '¥9.90');
  await page.pay();
  assert.equal(page.data.cashier, null);
  assert.ok(page.data.result.transfers[0].detail.contact, '支付后应展示联系方式');
  assert.equal(page.data.result.transfers[0].unlocked, true);

  await page.book();                                   // 未勾选同意回访：只提示，不提交
  assert.equal(page.data.tickets.length, 0);
  page.onContactAccept({detail: {value: ['yes']}});
  page.onWindow({currentTarget: {dataset: {i: 2}}});
  await page.book();
  assert.equal(page.data.step, 3);
  assert.equal(page.data.tickets[0].status, 'pending');
  assert.equal(page.data.tickets[0].timeWindow, page.data.windows[2]);
  assert.equal(page.data.booked, true);

  await page.withdraw({currentTarget: {dataset: {id: page.data.tickets[0].id}}});
  assert.equal(page.data.tickets[0].status, 'withdrawn');
  assert.equal(page.data.booked, false);

  page.restart();
  assert.equal(page.data.step, 1);
  assert.equal(page.data.result, null);
  assert.equal(page.token, null);
});

test('小程序页面：核验不通过时停在第一步并提示原因', async () => {
  const api = load('utils/api.js', {'../config': {baseUrl: base}});
  let definition;
  load('pages/index/index.js', {'../../utils/api': api}, {Page: value => { definition = value; }});
  const page = {...definition, data: structuredClone(definition.data), setData(patch) { for (const [k, v] of Object.entries(patch)) setPath(this.data, k, v); }};
  await page.onLoad({});
  page.fillPersona({currentTarget: {dataset: {i: page.data.personas.findIndex(p => p.id === 'mismatch')}}});
  await page.submit();
  assert.equal(page.data.step, 1);
  assert.match(page.data.error, /不一致/);
});
