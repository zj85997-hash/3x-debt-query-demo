import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {checkDigit, isValidId, isValidName, normalizeId, normalizeName} from '../../src/domain/idcard.mjs';

test('校验码：国家标准 GB 11643 的示例号码', () => {
  assert.equal(checkDigit('11010519491231002'), 'X');
  assert.ok(isValidId('11010519491231002X'));
});
test('校验码错误、日期不存在、未来日期、长度不对一律无效', () => {
  assert.equal(isValidId('110105194912310021'), false);
  assert.equal(isValidId('110105194902300025'), false);   // 2 月 30 日
  assert.equal(isValidId('11010520991231002X'), false);   // 未来
  assert.equal(isValidId('1101051949123100'), false);
  assert.equal(isValidId(''), false);
});
test('输入规范化：全角数字、空格、小写 x', () => {
  assert.equal(normalizeId(' １１０１０５１９４９１２３１００２x '), '11010519491231002X');
  assert.equal(normalizeName('  张三　'), '张三');
  assert.equal(normalizeId(12345), '');
});
test('姓名：2–20 个汉字，允许间隔号', () => {
  assert.ok(isValidName('张三'));
  assert.ok(isValidName('阿卜杜拉·买买提'));
  assert.equal(isValidName('张'), false);
  assert.equal(isValidName('Zhang San'), false);
  assert.equal(isValidName('张三<script>'), false);
});
