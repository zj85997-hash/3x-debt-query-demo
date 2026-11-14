// 虚构人口生成器：Demo、压测、模拟核验共用同一套确定性规则，全程不接触任何真实个人信息。
// 安全边界：所有虚构证件号以 99 开头——现行行政区划代码没有 99 开头的省级代码，因此不可能与真实身份证号重合。
import {checkDigit} from './idcard.mjs';

const SURNAMES = [...'王李张刘陈杨黄赵吴周徐孙马朱胡郭何林高罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵'];
const GIVEN = [...'伟芳娜敏静丽强磊军洋勇艳杰娟涛明超秀霞平刚桂英华慧建国文斌宇浩鑫欣怡梓涵子轩雨婷晨曦嘉懿思远志鹏'];
const HOLDERS = ['示例甲资产管理有限公司（演示）', '示例乙资产管理有限公司（演示）', '示例丙金融服务有限公司（演示）'];
const ORIGINATORS = ['示例银行信用卡中心', '示例消费金融公司', '示例城市商业银行', '示例小额贷款公司', '示例农村商业银行'];
const TRANSFEREES = ['示例丁资产管理有限公司（演示）', '示例戊资产管理有限公司（演示）', '示例己资产管理有限公司（演示）'];
const DAY = 86400000;
const BIRTH_BASE = Date.UTC(1970, 0, 1);

// 确定性整数散列（同一个编号永远得到同一组属性）
function mix(n, salt) {
  let x = (n + salt * 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}
const pick = (list, n, salt) => list[mix(n, salt) % list.length];
const isoDate = ms => new Date(ms).toISOString().slice(0, 10);

/** 人口分段：编号区间决定这个人在库里有什么记录 */
export const SEG = Object.freeze({
  own: [0, 400000],          // 自有授权资产，每人 1 笔
  ownMulti: [0, 50000],      // 其中这一段的人另有第 2 笔（一人多债）
  history: [400000, 450000], // 仅有已核实的历史转让记录
  historyMulti: [400000, 405000], // 其中这一段有 2 条转让记录
  candidate: [450000, 460000],    // 仅有脱敏公告候选；编号能被 500 整除的存在"同名同尾号"冲突
  expired: [460000, 462000],      // 仅有委托已到期的资产（不应再展示）
  empty: [462000, 1000000]        // 库里没有任何记录
});
export const POPULATION = SEG.empty[1];

export function nameOf(i) {
  const second = mix(i, 3) % 4 === 0 ? '' : pick(GIVEN, i, 4);
  return pick(SURNAMES, i, 1) + pick(GIVEN, i, 2) + second;
}
export function idOf(i) {
  const region = 990000 + Math.floor(i / 1e7);
  const birth = isoDate(BIRTH_BASE + (Math.floor(i / 1000) % 10000) * DAY).replaceAll('-', '');
  const body = String(region) + birth + String(i % 1000).padStart(3, '0');
  return body + checkDigit(body);
}
export const personOf = i => ({index: i, name: nameOf(i), idNo: idOf(i)});

/** 由虚构证件号反推编号；不是本生成器产生的号码返回 -1 */
export function indexOfId(idNo) {
  if (!/^99\d{15}[\dX]$/.test(idNo)) return -1;
  const region = Number(idNo.slice(0, 6)) - 990000;
  const birth = Date.UTC(Number(idNo.slice(6, 10)), Number(idNo.slice(10, 12)) - 1, Number(idNo.slice(12, 14)));
  const days = Math.round((birth - BIRTH_BASE) / DAY);
  if (region < 0 || region > 99 || days < 0 || days > 9999) return -1;
  const i = region * 1e7 + days * 1000 + Number(idNo.slice(14, 17));
  return idOf(i) === idNo ? i : -1;
}
export const isSyntheticId = idNo => indexOfId(idNo) >= 0;

const inSeg = (i, [from, to]) => i >= from && i < to;
export function segmentOf(i) {
  for (const name of ['own', 'history', 'candidate', 'expired']) if (inSeg(i, SEG[name])) return name;
  return 'empty';
}

/** 某人的自有资产（0–2 笔），金额单位：分 */
export function assetsOf(i) {
  const expired = inSeg(i, SEG.expired);
  if (!inSeg(i, SEG.own) && !expired) return [];
  const count = inSeg(i, SEG.ownMulti) ? 2 : 1;
  return Array.from({length: count}, (_, k) => {
    const n = i * 2 + k;
    const principal = (3000 + mix(n, 11) % 77000) * 100;
    return {
      debtNo: 'D' + String(100000000 + n),
      packageNo: 'PKG-2025-' + String(1 + mix(n, 12) % 24).padStart(2, '0'),
      holder: pick(HOLDERS, n, 13),
      originator: pick(ORIGINATORS, n, 14),
      loanDate: isoDate(Date.UTC(2019, 0, 1) + (mix(n, 15) % 1800) * DAY),
      principalFen: principal,
      balanceFen: Math.round(principal * (1.08 + (mix(n, 16) % 60) / 100)),
      asOf: '2026-11-10',
      mandateStatus: expired ? 0 : 1
    };
  });
}
/** 某人的已核实历史转让记录（0–2 条） */
export function transfersOf(i) {
  if (!inSeg(i, SEG.history)) return [];
  const count = inSeg(i, SEG.historyMulti) ? 2 : 1;
  return Array.from({length: count}, (_, k) => {
    const n = i * 2 + k;
    return {
      transferor: pick(ORIGINATORS, n, 21),
      transferee: pick(TRANSFEREES, n, 22),
      transferDate: isoDate(Date.UTC(2024, 0, 1) + (mix(n, 23) % 660) * DAY),
      amountFen: (5000 + mix(n, 24) % 95000) * 100,
      noticeRef: 'DEMO-NOTICE-' + String(2025000 + mix(n, 25) % 900),
      contact: '400-000-' + String(1000 + mix(n, 26) % 9000) + '（演示）'
    };
  });
}
/** 某人的脱敏公告候选（0–2 条）；2 条表示公告层面无法区分（同名同尾号） */
export function candidatesOf(i) {
  if (!inSeg(i, SEG.candidate)) return [];
  const count = i % 500 === 0 ? 2 : 1;
  return Array.from({length: count}, (_, k) => ({
    sourceRef: 'DEMO-ANN-' + String(i) + '-' + (k + 1),
    sourcePage: 1 + mix(i * 2 + k, 31) % 340,
    noticeDate: isoDate(Date.UTC(2025, 0, 1) + (mix(i * 2 + k, 32) % 300) * DAY)
  }));
}

/** 页面上的"演示身份"卡片 */
export const PERSONAS = Object.freeze([
  {id: 'own', label: '自有资产 · 1 笔', hint: '核验后命中授权台账', index: 60018},
  {id: 'own-multi', label: '自有资产 · 一人两笔', hint: '同一人两笔债务分别展示', index: 1},
  {id: 'history', label: '历史转让 · 可付费解锁', hint: '基础信息免费，详情 ¥9.90', index: 420123},
  {id: 'history-multi', label: '历史转让 · 两条记录', hint: '逐条解锁', index: 400001},
  {id: 'candidate', label: '公告候选 · 待人工核实', hint: '仅脱敏公告线索', index: 450001},
  {id: 'ambiguous', label: '同名同尾号 · 冲突', hint: '不任选其一，转人工', index: 450500},
  {id: 'expired', label: '委托已到期', hint: '到期资产不再展示', index: 460005},
  {id: 'empty', label: '暂无记录', hint: '收录范围内未检出', index: 500000},
  {id: 'mismatch', label: '核验不通过', hint: '姓名与证件号不一致', index: 60018, wrongName: true}
].map(p => {
  const person = personOf(p.index);
  let name = person.name;
  if (p.wrongName) for (let k = 7; name === person.name; k++) name = nameOf(p.index + k); // 换成另一个人的姓名
  return Object.freeze({id: p.id, label: p.label, hint: p.hint, name, idNo: person.idNo});
}));
