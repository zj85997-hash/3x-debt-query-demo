// 小程序首页：本人核验 → 查询结果 →（付费解锁）→ 预约人工。业务规则全部在服务端，这里只负责展示与交互。
const api = require('../../utils/api');

const HEAD = {
  own: ['自有授权资产', '已核实到与你相关的记录', '已在获授权的业务资料中核实到相关记录。如需确认还款账户、开具结清证明或了解方案，请申请人工服务。'],
  history: ['有历史转让记录', '查到已核实的债权转让记录', '以下为基础信息。完整信息（含新债权人及其联系方式）可付费查看。'],
  candidate: ['待人工核实', '存在待核实的公告线索', '存在可能相关的公告线索，尚不能确认是否对应本人，也不能确认当前债权状态。可申请人工核实。'],
  empty: ['暂无可展示记录', '当前收录范围内未找到相关信息', '这不代表不存在欠款，也不代表债权未发生转让。如有疑问可申请人工核实。'],
  unavailable: ['查询暂不可用', '本次查询暂未完成', '系统暂时无法完成查询，这不代表没有记录。请稍后重试。']
};
const TICKET = {pending: '待回访', replied: '已回复', withdrawn: '已取消'};
const yuan = fen => '¥' + (fen / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const explain = error => (error.code === 'RATE_LIMITED' && error.retryAfterMs
  ? '操作过于频繁，请 ' + Math.ceil(error.retryAfterMs / 1000) + ' 秒后再试' : error.message || '操作失败，请稍后重试');

Page({
  data: {
    ready: false, demo: false, personas: [], policy: null, price: '', windows: [], windowIndex: 0,
    name: '', idNo: '', accepted: false, contactAccepted: false,
    busy: false, busyText: '', error: '',
    step: 1, profile: null, result: null, head: null, tickets: [], showPolicy: false,
    cashier: null, payState: ''
  },
  async onLoad(options) {
    this.channel = (options && options.ch) || '';
    try {
      const meta = await api.getMeta();
      this.meta = meta;
      this.setData({ready: true, demo: meta.mode === 'demo', personas: meta.personas || [], policy: meta.policy,
        price: yuan(meta.unlock.priceFen), windows: meta.callbackWindows, contactPolicy: meta.contactPolicy, operator: meta.operator});
    } catch (error) { this.setData({error: '页面初始化失败，请下拉重试'}); }
  },
  onName(e) { this.setData({name: e.detail.value}); },
  onIdNo(e) { this.setData({idNo: e.detail.value}); },
  onAccept(e) { this.setData({accepted: e.detail.value.length > 0}); },
  onContactAccept(e) { this.setData({contactAccepted: e.detail.value.length > 0}); },
  onWindow(e) { this.setData({windowIndex: Number(e.currentTarget.dataset.i)}); },
  togglePolicy() { this.setData({showPolicy: !this.data.showPolicy}); },
  fillPersona(e) {
    const persona = this.data.personas[Number(e.currentTarget.dataset.i)];
    this.setData({name: persona.name, idNo: persona.idNo, accepted: true, error: ''});
  },
  waitHint(label) {
    return info => this.setData({busyText: info.code === 'VERIFY_BUSY' ? '当前核验人数较多，正在为你排队（第 ' + info.attempt + ' 次重试）' : label});
  },
  async submit() {
    if (this.data.busy) return;
    const name = this.data.name.trim(), idNo = this.data.idNo.trim().toUpperCase();
    if (!name || !idNo) return this.setData({error: '请填写姓名和证件号码'});
    if (!this.data.accepted) return this.setData({error: '请先阅读并同意《查询说明与授权》'});
    this.setData({busy: true, busyText: '正在核验身份…', error: ''});
    try {
      if (!this.session) this.session = (await api.openSession(this.channel)).token;
      const verified = await api.verify(this.session, name, idNo, this.meta.policy.version, this.waitHint('正在核验身份…'));
      this.token = verified.token;
      this.setData({profile: verified.profile, name: '', idNo: ''});
      await this.runQuery();
    } catch (error) {
      if (error.status === 401) this.session = null;
      this.setData({error: explain(error)});
    } finally { this.setData({busy: false, busyText: ''}); }
  },
  async runQuery() {
    this.setData({busyText: '正在查询…'});
    let result;
    try { result = await api.query(this.token, this.waitHint('正在查询…')); }
    catch (error) {
      if (error.status === 401) throw error;
      result = {state: 'unavailable'};
    }
    if (result.records) result.records = result.records.map(a => Object.assign({}, a, {principalText: yuan(a.principalFen), balanceText: yuan(a.balanceFen)}));
    if (result.transfers) result.transfers = result.transfers.map(t => Object.assign({}, t, {amountText: yuan(t.amountFen), detail: null}));
    let tickets = [];
    if (result.state !== 'unavailable') { try { tickets = (await api.listCallbacks(this.token)).tickets; } catch (error) { tickets = []; } }
    this.setData({step: 2, result, head: HEAD[result.state], contactAccepted: false});
    this.showTickets(tickets);
  },
  showTickets(tickets) {
    const queryId = this.data.result && this.data.result.queryId;
    this.setData({
      tickets: tickets.map(t => Object.assign({}, t, {statusText: TICKET[t.status] || t.status, timeText: t.createdAt.slice(0, 16)})),
      booked: tickets.some(t => t.queryId === queryId && t.status === 'pending')
    });
  },
  async retry() {
    if (this.data.busy) return;
    this.setData({busy: true});
    try { await this.runQuery(); } catch (error) { this.expired(error); } finally { this.setData({busy: false, busyText: ''}); }
  },
  expired(error) {
    if (error && error.status === 401) { wx.showToast({title: '登录已过期，请重新核验', icon: 'none'}); this.restart(); }
    else if (error) wx.showToast({title: explain(error), icon: 'none'});
  },
  // 付费解锁：下单 → 收银台 →（演示环境模拟支付）→ 轮询订单到"已支付" → 读取完整信息
  async unlock(e) {
    if (this.data.busy) return;
    const index = Number(e.currentTarget.dataset.i);
    const transfer = this.data.result.transfers[index];
    this.setData({busy: true});
    try {
      if (transfer.unlocked) return await this.reveal(index);
      const order = await api.createOrder(this.token, this.data.result.queryId, transfer.recordId);
      if (order.alreadyUnlocked) return await this.reveal(index);
      this.setData({cashier: {index, orderNo: order.orderNo, amountText: yuan(order.amountFen), fields: this.meta.unlock.fields}, payState: ''});
    } catch (error) { this.expired(error); } finally { this.setData({busy: false}); }
  },
  closeCashier() { this.setData({cashier: null, payState: ''}); },
  async pay() {
    const cashier = this.data.cashier;
    if (!cashier || this.paying) return;
    this.paying = true;
    this.setData({payState: '支付处理中…'});
    try {
      // 演示环境：模拟支付。正式环境：此处改为 wx.requestPayment（参数来自下单接口返回的预支付信息）
      await api.mockPay(this.token, cashier.orderNo);
      let paid = false;
      for (let i = 0; i < 25 && !paid; i++) {
        paid = (await api.getOrder(this.token, cashier.orderNo)).status === 'paid';
        if (!paid) await api.sleep(300);
      }
      if (!paid) return this.setData({payState: '支付结果确认中，请稍后重新查询查看'});
      await this.reveal(cashier.index);
      this.setData({cashier: null, payState: ''});
      wx.showToast({title: '已解锁完整信息', icon: 'success'});
    } catch (error) {
      if (error.status === 401) { this.setData({cashier: null}); this.expired(error); } else this.setData({payState: explain(error)});
    } finally { this.paying = false; }
  },
  async reveal(index) {
    const transfer = this.data.result.transfers[index];
    const detail = await api.getRecord(this.token, transfer.recordId);
    detail.amountText = yuan(detail.amountFen);
    this.setData({['result.transfers[' + index + '].detail']: detail, ['result.transfers[' + index + '].unlocked']: true});
  },
  async book() {
    if (this.data.busy) return;
    if (!this.data.contactAccepted) return wx.showToast({title: '请先勾选同意回访', icon: 'none'});
    this.setData({busy: true});
    try {
      await api.createCallback(this.token, this.data.result.queryId, this.data.windows[this.data.windowIndex]);
      this.showTickets((await api.listCallbacks(this.token)).tickets);
      this.setData({step: 3});
      wx.showToast({title: '预约已登记', icon: 'success'});
    } catch (error) { this.expired(error); } finally { this.setData({busy: false}); }
  },
  async withdraw(e) {
    if (this.data.busy) return;
    this.setData({busy: true});
    try {
      await api.withdrawCallback(this.token, e.currentTarget.dataset.id);
      this.showTickets((await api.listCallbacks(this.token)).tickets);
      this.setData({step: 2});
    } catch (error) { this.expired(error); } finally { this.setData({busy: false}); }
  },
  restart() {
    this.token = null;
    this.session = null;
    this.setData({step: 1, profile: null, result: null, head: null, tickets: [], booked: false, accepted: false, contactAccepted: false, cashier: null, error: ''});
  }
});
