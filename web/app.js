// 债权信息查询 · H5 页面逻辑（原生 ES 模块，无构建步骤）
import * as api from '/assets/api.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const yuan = fen => '¥' + (fen / 100).toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const channel = new URLSearchParams(location.search).get('ch') || '';

const state = {meta: null, profile: null, result: null, details: new Map(), tickets: []};

// ── 通用界面部件
function busy(text, sub = '') {
  $('busy').hidden = !text;
  if (text) { $('busy-text').textContent = text; $('busy-sub').textContent = sub; }
}
let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600);
}
function openSheet(title, html) {
  $('sheet-title').textContent = title;
  $('sheet-body').innerHTML = html;
  $('sheet').hidden = false;
}
const closeSheet = () => { $('sheet').hidden = true; $('sheet-body').replaceChildren(); };
$('sheet-close').addEventListener('click', closeSheet);
$('sheet').addEventListener('click', event => { if (event.target === $('sheet')) closeSheet(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('sheet').hidden) closeSheet(); });

function setStep(current, done = []) {
  for (const item of $('steps').children) {
    const step = Number(item.dataset.step);
    item.classList.toggle('is-current', step === current);
    item.classList.toggle('is-done', done.includes(step));
  }
}
function explain(error) {
  if (error.code === 'RATE_LIMITED' && error.retryAfterMs) {
    const seconds = Math.ceil(error.retryAfterMs / 1000);
    return `操作过于频繁，请 ${seconds >= 120 ? Math.ceil(seconds / 60) + ' 分钟' : seconds + ' 秒'}后再试`;
  }
  return error.message || '操作失败，请稍后重试';
}
const waitHint = label => ({attempt, code}) => busy(
  code === 'VERIFY_BUSY' ? '当前核验人数较多，正在为你排队' : label,
  `系统繁忙时会自动重试 · 第 ${attempt} 次`);

// ── 技术面板：记录每一次接口调用
api.onCall(call => {
  const body = $('calls');
  body.querySelector('.calls-empty')?.remove();
  const row = document.createElement('tr');
  const cls = call.status >= 500 || call.status === 0 ? 's5' : call.status >= 400 ? 's4' : 's2';
  const shown = call.path.replace('/api/v1', '').replace(/\d{10,}/g, id => '…' + id.slice(-4));   // 长编号只显示末四位
  row.innerHTML = `<td class="path" title="${esc(call.path)}">${esc(call.method)} ${esc(shown)}</td>` +
    `<td class="${cls}">${call.status || '断开'}${call.code && call.status >= 400 ? ' ' + esc(call.code) : ''}</td>` +
    `<td>${call.ms} ms</td><td class="inst">${esc(call.instance.replace(/^.*-api-/, 'api-') || '—')}</td>`;
  body.prepend(row);
  while (body.children.length > 60) body.lastChild.remove();
});

// ── 第一步：核验
function renderPersonas() {
  const personas = state.meta.personas || [];
  $('personas-card').hidden = !personas.length;
  $('demo-fineprint').hidden = !personas.length;
  $('personas').innerHTML = personas.map((p, i) =>
    `<button type="button" class="persona" data-i="${i}"><b>${esc(p.label)}</b><small>${esc(p.hint)}</small></button>`).join('');
}
$('personas').addEventListener('click', event => {
  const button = event.target.closest('.persona');
  if (!button) return;
  const persona = state.meta.personas[Number(button.dataset.i)];
  $('name').value = persona.name;
  $('idno').value = persona.idNo;
  $('accept').checked = true;
  $('verify-error').textContent = '';
  for (const el of $('personas').children) el.classList.toggle('is-active', el === button);
});
$('open-policy').addEventListener('click', () => {
  const {policy} = state.meta;
  openSheet(policy.title, `<ol class="policy-list">${policy.items.map(item => `<li>${esc(item)}</li>`).join('')}</ol><p class="policy-version">文本版本 ${esc(policy.version)}</p>`);
});
$('verify-form').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('name').value.trim();
  const idNo = $('idno').value.trim().toUpperCase();
  const error = $('verify-error');
  error.textContent = '';
  if (!name || !idNo) { error.textContent = '请填写姓名和证件号码'; return; }
  if (!$('accept').checked) { error.textContent = '请先阅读并同意《查询说明与授权》'; return; }
  $('verify-submit').disabled = true;
  try {
    busy('正在核验身份…');
    state.profile = await api.verify({name, idNo, policyVersion: state.meta.policy.version, channel, onWait: waitHint('正在核验身份…')});
    await runQuery();
    $('name').value = '';
    $('idno').value = '';
  } catch (err) {
    busy('');
    error.textContent = explain(err);
  } finally {
    $('verify-submit').disabled = false;
  }
});

// ── 第二步：查询与结果
async function runQuery() {
  busy('正在查询…');
  state.details.clear();
  try {
    state.result = await api.query(waitHint('正在查询…'));
  } catch (err) {
    if (err.status === 401) throw err;
    state.result = {state: 'unavailable', message: explain(err)};
  }
  try { state.tickets = state.result.state === 'unavailable' ? [] : (await api.listCallbacks()).tickets; } catch { state.tickets = []; }
  busy('');
  showResult();
}
const HEAD = {
  own: ['pill-ok', '自有授权资产', '已核实到与你相关的记录', '已在获授权的业务资料中核实到相关记录。如需确认还款账户、开具结清证明或了解方案，请申请人工服务。'],
  history: ['pill-info', '有历史转让记录', '查到已核实的债权转让记录', '以下为基础信息。完整信息（含新债权人及其联系方式）可付费查看。'],
  candidate: ['pill-warn', '待人工核实', '存在待核实的公告线索', '存在可能相关的公告线索，尚不能确认是否对应本人，也不能确认当前债权状态。可申请人工核实。'],
  empty: ['pill-mute', '暂无可展示记录', '当前收录范围内未找到相关信息', '这不代表不存在欠款，也不代表债权未发生转让。如有疑问可申请人工核实。'],
  unavailable: ['pill-bad', '查询暂不可用', '本次查询暂未完成', '系统暂时无法完成查询，这不代表没有记录。请稍后重试。']
};
const rows = pairs => '<dl class="rows">' + pairs.map(([label, value, cls]) => `<dt>${esc(label)}</dt><dd${cls ? ` class="${cls}"` : ''}>${esc(value)}</dd>`).join('') + '</dl>';

function transferCard(t, index, total) {
  const detail = state.details.get(t.recordId);
  const title = `<div class="record-title"><span>转让记录${total > 1 ? ' ' + (index + 1) : ''}</span>${detail ? '<span class="pill pill-ok">已解锁</span>' : ''}</div>`;
  if (detail) {
    return `<div class="record">${title}${rows([
      ['欠款人', detail.debtor], ['债权出让方（贷款方）', detail.transferor], ['债权受让方（新债权人）', detail.transferee],
      ['转让日期', detail.transferDate], ['转让金额', yuan(detail.amountFen), 'money'], ['受让方联系方式', detail.contact], ['公告编号', detail.noticeRef]
    ])}</div>`;
  }
  return `<div class="record">${title}${rows([
    ['是否已转让', '是'], ['转让日期', t.transferDate], ['转让金额', yuan(t.amountFen), 'money'],
    ['债权出让方', '＊＊＊＊', 'locked'], ['债权受让方', '＊＊＊＊', 'locked'], ['受让方联系方式', '＊＊＊＊', 'locked']
  ])}<div class="unlock-bar"><p>解锁后可查看全部 6 项信息</p>` +
    `<button type="button" class="btn btn-pay btn-sm" data-unlock="${esc(t.recordId)}">${t.unlocked ? '查看完整信息' : yuan(state.meta.unlock.priceFen) + ' 解锁'}</button></div></div>`;
}
function showResult() {
  const r = state.result;
  const [pill, label, title, desc] = HEAD[r.state];
  $('view-verify').hidden = true;
  $('view-result').hidden = false;
  setStep(2, [1]);
  const name = state.profile.nameMasked;
  $('identity').innerHTML = `<div class="avatar">${esc([...name][0])}</div><div class="who"><b>${esc(name)}</b><small>${esc(state.profile.idMasked)}</small></div><span class="pill pill-ok">已核验</span>`;

  let body = '';
  if (r.state === 'own') {
    body = r.records.map((a, i) => `<div class="record"><div class="record-title"><span>债务${r.records.length > 1 ? ' ' + (i + 1) : ''}</span><span class="muted">数据时点 ${esc(a.asOf)}</span></div>${rows([
      ['债权主体', a.holder], ['原贷款方', a.originator], ['贷款日期', a.loanDate], ['贷款本金', yuan(a.principalFen), 'money'], ['欠款本息', yuan(a.balanceFen), 'money']
    ])}</div>`).join('') + '<p class="note">金额为数据时点的台账记录，实际应还金额以服务机构复核为准。</p>';
  } else if (r.state === 'history') {
    body = r.transfers.map((t, i) => transferCard(t, i, r.transfers.length)).join('') + '<p class="note">转让记录反映的是历史事件，当前债权状态请以受让方答复为准。</p>';
  } else if (r.state === 'candidate' && r.ambiguous) {
    body = '<p class="note">现有公告资料不足以区分相关记录，系统不会任选其一作为你的结果。</p>';
  } else if (r.state === 'unavailable') {
    body = '<button type="button" class="btn btn-soft btn-block" id="retry-query">重新查询</button>';
  }
  $('result').innerHTML = `<section class="card"><div class="result-head"><h2>${esc(title)}</h2><span class="pill ${pill}">${esc(label)}</span></div>` +
    `<p class="result-desc">${esc(desc)}</p>${body}${r.queryId ? `<p class="result-meta">查询编号 ${esc(r.queryId)}</p>` : ''}</section>`;
  $('retry-query')?.addEventListener('click', () => runQuery().catch(handleExpired));
  renderAssist();
  renderTickets();
  window.scrollTo({top: 0});
}
$('result').addEventListener('click', event => {
  const button = event.target.closest('[data-unlock]');
  if (button) unlock(button.dataset.unlock, button).catch(handleExpired);
});
function handleExpired(error) {
  if (error?.status === 401) { toast('登录状态已过期，请重新核验'); restart(); } else if (error) toast(explain(error));
}

// ── 付费解锁
async function unlock(recordId, button) {
  button.disabled = true;
  try {
    const transfer = state.result.transfers.find(t => t.recordId === recordId);
    if (transfer.unlocked) return await reveal(recordId);
    const order = await api.createOrder(state.result.queryId, recordId, crypto.randomUUID());
    if (order.alreadyUnlocked) return await reveal(recordId);
    openCashier(order, recordId);
  } finally { button.disabled = false; }
}
async function reveal(recordId) {
  state.details.set(recordId, await api.getRecord(recordId));
  const transfer = state.result.transfers.find(t => t.recordId === recordId);
  transfer.unlocked = true;
  showResult();
}
function openCashier(order, recordId) {
  const {unlock: info} = state.meta;
  openSheet('确认支付', `<div class="cashier">
    <p class="demo-banner">模拟收银台 · 演示环境不会产生真实扣款</p>
    <p class="amount"><small>¥</small>${(order.amountFen / 100).toFixed(2)}</p>
    <p class="item">债权转让详情解锁 · 订单 ${esc(order.orderNo.slice(-8))}</p>
    <div class="fields">${info.fields.map(f => `<span>· ${esc(f)}</span>`).join('')}</div>
    <button type="button" class="btn btn-pay btn-block" id="pay-confirm">确认支付（模拟）</button>
    <p class="state" id="pay-state"></p></div>`);
  $('pay-confirm').addEventListener('click', async () => {
    const button = $('pay-confirm'), tip = $('pay-state');
    button.disabled = true;
    tip.className = 'state';
    tip.textContent = '支付处理中…';
    try {
      await api.mockPay(order.orderNo);
      // 以服务端订单状态为准：轮询到"已支付"才展示内容
      let paid = false;
      for (let i = 0; i < 25 && !paid; i++) {
        paid = (await api.getOrder(order.orderNo)).status === 'paid';
        if (!paid) await sleep(300);
      }
      if (!paid) { tip.className = 'state bad'; tip.textContent = '支付结果确认中，请稍后重新查询查看'; button.disabled = false; return; }
      tip.className = 'state ok';
      tip.textContent = '支付成功，正在解锁…';
      await reveal(recordId);
      closeSheet();
      toast('已解锁完整信息');
    } catch (error) {
      if (error.status === 401) { closeSheet(); return handleExpired(error); }
      tip.className = 'state bad';
      tip.textContent = explain(error);
      button.disabled = false;
    }
  });
}

// ── 第三步：人工协助
function renderAssist() {
  const box = $('assist');
  const r = state.result;
  const booked = state.tickets.some(t => t.queryId === r.queryId && t.status === 'pending');
  box.hidden = r.state === 'unavailable' || booked;
  if (box.hidden) return;
  const {callbackWindows, contactPolicy} = state.meta;
  box.innerHTML = `<h2>申请人工协助</h2><p class="result-desc">${esc(contactPolicy)}</p>
    <form id="assist-form"><div class="windows">${callbackWindows.map((w, i) =>
      `<label><input type="radio" name="window" value="${esc(w)}"${i === 0 ? ' checked' : ''}><span>${esc(w)}</span></label>`).join('')}</div>
    <label class="check"><input type="checkbox" id="contact-accept"><span>我同意工作人员在所选时段与我联系（可随时撤回）</span></label>
    <p class="form-error" id="assist-error" role="alert"></p>
    <button class="btn btn-soft btn-block" type="submit">提交预约</button></form>`;
  $('assist-form').addEventListener('submit', async event => {
    event.preventDefault();
    const error = $('assist-error');
    error.textContent = '';
    if (!$('contact-accept').checked) { error.textContent = '请先勾选同意回访'; return; }
    const button = event.target.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      await api.createCallback(r.queryId, new FormData(event.target).get('window'));
      state.tickets = (await api.listCallbacks()).tickets;
      renderAssist();
      renderTickets();
      setStep(3, [1, 2]);
      toast('预约已登记');
    } catch (err) {
      if (err.status === 401) return handleExpired(err);
      error.textContent = explain(err);
      button.disabled = false;
    }
  });
}
const TICKET = {pending: ['pill-info', '待回访'], replied: ['pill-ok', '已回复'], withdrawn: ['pill-mute', '已取消']};
function renderTickets() {
  const box = $('tickets');
  box.hidden = !state.tickets.length;
  if (box.hidden) return;
  box.innerHTML = '<h2>我的预约</h2>' + state.tickets.map(t => {
    const [pill, label] = TICKET[t.status] || TICKET.pending;
    return `<div class="ticket"><div><b>${esc(t.timeWindow)}</b><small>${esc(t.createdAt.slice(0, 16))} · 编号 ${esc(t.id.slice(-6))}</small></div>` +
      `<div class="ticket-side"><span class="pill ${pill}">${label}</span>${t.status === 'pending' ? `<button type="button" class="btn btn-ghost btn-sm" data-withdraw="${esc(t.id)}">取消</button>` : ''}</div></div>`;
  }).join('');
}
$('tickets').addEventListener('click', async event => {
  const button = event.target.closest('[data-withdraw]');
  if (!button) return;
  button.disabled = true;
  try {
    await api.withdrawCallback(button.dataset.withdraw);
    state.tickets = (await api.listCallbacks()).tickets;
    renderAssist();
    renderTickets();
    setStep(2, [1]);
    toast('预约已取消');
  } catch (error) { button.disabled = false; handleExpired(error); }
});

function restart() {
  api.logout();
  Object.assign(state, {profile: null, result: null, tickets: []});
  state.details.clear();
  $('view-result').hidden = true;
  $('view-verify').hidden = false;
  $('accept').checked = false;
  $('verify-error').textContent = '';
  for (const el of $('personas').children) el.classList.remove('is-active');
  setStep(1);
  window.scrollTo({top: 0});
}
$('restart').addEventListener('click', restart);

// ── 启动
try {
  state.meta = await api.getMeta();
  $('env-tag').hidden = state.meta.mode !== 'demo';
  $('operator').textContent = '运营主体：' + state.meta.operator;
  renderPersonas();
} catch {
  $('verify-error').textContent = '页面初始化失败，请刷新重试';
  $('verify-submit').disabled = true;
}
