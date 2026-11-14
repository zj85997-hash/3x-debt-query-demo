// 统一错误模型。所有对外错误都有稳定的字符串错误码，前端与压测脚本只认错误码，不解析中文文案。
export class AppError extends Error {
  /**
   * @param {string} code    稳定错误码
   * @param {number} status  HTTP 状态码
   * @param {string} message 给用户看的中文说明
   * @param {object} [extra] retryAfterMs：建议的重试等待；其余字段原样返回
   */
  constructor(code, status, message, extra = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}
const make = (code, status, message) => (overrideMessage, extra) => new AppError(code, status, overrideMessage || message, extra);
export const E = {
  badRequest: make('BAD_REQUEST', 400, '请求内容有误'),
  unauthenticated: make('UNAUTHENTICATED', 401, '登录状态已失效，请重新进入'),
  verifyRequired: make('VERIFY_REQUIRED', 401, '请先完成本人核验'),
  forbidden: make('FORBIDDEN', 403, '无权访问'),
  notFound: make('NOT_FOUND', 404, '记录不存在'),
  conflict: make('CONFLICT', 409, '当前状态不允许该操作'),
  policyOutdated: make('POLICY_OUTDATED', 409, '查询说明已更新，请重新阅读并同意'),
  consentRequired: make('CONSENT_REQUIRED', 400, '请先阅读并同意查询说明'),
  nameFormat: make('NAME_FORMAT', 422, '姓名格式不正确'),
  idFormat: make('ID_FORMAT', 422, '证件号码格式不正确'),
  demoIdOnly: make('DEMO_ID_ONLY', 422, '演示环境只接受页面提供的虚构身份，请勿输入真实证件号'),
  verifyMismatch: make('VERIFY_MISMATCH', 422, '姓名与证件号码不一致，未通过本人核验'),
  rateLimited: make('RATE_LIMITED', 429, '操作过于频繁，请稍后再试'),
  serverBusy: make('SERVER_BUSY', 503, '当前访问人数较多，请稍后重试'),
  verifyBusy: make('VERIFY_BUSY', 503, '当前核验人数较多，正在为你排队'),
  verifyUnavailable: make('VERIFY_UNAVAILABLE', 503, '本人核验服务暂时不可用，请稍后重试'),
  queryUnavailable: make('QUERY_UNAVAILABLE', 503, '查询暂不可用，请稍后重试'),
  payUnavailable: make('PAY_UNAVAILABLE', 503, '支付服务暂时不可用，请稍后重试'),
  featureDisabled: make('FEATURE_DISABLED', 503, '该功能暂时关闭'),
  internal: make('INTERNAL', 500, '服务内部错误')
};
// 基础设施层抛出的忙/断路错误（由各模块翻译为上面的业务错误码）
export class BusyError extends Error {
  constructor(resource, reason) { super(`${resource} busy: ${reason}`); this.name = 'BusyError'; this.resource = resource; this.reason = reason; }
}
export class CircuitOpenError extends Error {
  constructor(resource, retryAfterMs) { super(`${resource} circuit open`); this.name = 'CircuitOpenError'; this.resource = resource; this.retryAfterMs = retryAfterMs; }
}
