// 页面初始化信息：运营主体说明、查询说明（授权文本）、价格、回访时段；Demo 模式下附带演示身份。
import {config, demoMode} from '../config.mjs';
import {PERSONAS} from '../domain/synth.mjs';

const meta = {
  mode: config.app.mode,
  operator: '演示运营主体（Demo）',
  policy: {
    version: config.policy.version,
    title: '查询说明与授权',
    items: [
      '本服务仅供本人查询与自己相关的债权信息，查询前需完成本人身份核验。',
      '核验使用你填写的姓名和证件号码；平台不保存明文证件号码，只保存不可逆的匹配标识。',
      '查询范围限于已收录的授权台账、已核实的债权转让记录和公告线索。未查到不代表不存在欠款或未发生转让。',
      '我们会记录本次授权的文本版本、时间与查询结果状态，用于安全审计与争议处理。',
      '是否申请人工回访由你单独决定，不同意回访不影响查询。'
    ]
  },
  contactPolicy: '同意后，服务机构工作人员将在你选择的时段通过官方渠道与你联系，仅用于核实与答复本次查询。你可以随时撤回。',
  unlock: {priceFen: config.pay.priceFen, fields: ['欠款人', '债权出让方（贷款方）', '债权受让方（新债权人）', '转让日期', '转让金额', '受让方联系方式']},
  callbackWindows: config.policy.callbackWindows,
  ...(demoMode ? {personas: PERSONAS} : {})
};
export const getMeta = () => meta;
