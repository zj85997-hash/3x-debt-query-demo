// 居民身份证号码校验（GB 11643-1999）与输入规范化。格式校验只能排除错误输入，不能替代实名核验。
const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CHECK = '10X98765432';

export const checkDigit = body17 => {
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (body17.charCodeAt(i) - 48) * WEIGHTS[i];
  return CHECK[sum % 11];
};
export const normalizeId = raw => (typeof raw === 'string' ? raw.normalize('NFKC').replace(/\s+/g, '').toUpperCase() : '');
export const normalizeName = raw => (typeof raw === 'string' ? raw.normalize('NFKC').trim() : '');

export function isValidId(idNo) {
  if (!/^\d{17}[\dX]$/.test(idNo)) return false;
  const y = Number(idNo.slice(6, 10)), m = Number(idNo.slice(10, 12)), d = Number(idNo.slice(12, 14));
  const date = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d || date.getTime() > Date.now()) return false;
  return checkDigit(idNo.slice(0, 17)) === idNo[17];
}
/** 姓名：2–20 个汉字，允许间隔号（少数民族姓名） */
export const isValidName = name => /^[\p{Script=Han}]{1,10}(?:·[\p{Script=Han}]{1,10})*$/u.test(name) && [...name].length >= 2 && [...name].length <= 20;
