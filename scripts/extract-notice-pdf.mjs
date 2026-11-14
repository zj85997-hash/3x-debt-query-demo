// 公告 PDF → 候选 CSV 的示例（针对带文本层的 PDF；扫描件需先做 OCR，且识别结果必须人工复核后才能导入）。
// 用法：node scripts/extract-notice-pdf.mjs "fixtures/债权转让通知-虚构样本.pdf" > /tmp/candidates.csv
//       node scripts/import.mjs --kind candidates --file /tmp/candidates.csv --source "虚构样本公告"
// 依赖 Poppler 的 pdftotext。真实公告的版式各不相同：每接入一种版式，都要按样本单独写解析规则并抽检。
import {execFileSync} from 'node:child_process';

const file = process.argv[2];
if (!file) { console.error('请提供 PDF 文件路径'); process.exit(2); }
const rows = [];
const pages = execFileSync('pdftotext', ['-layout', file, '-'], {encoding: 'utf8', timeout: 30000}).split('\f');
pages.forEach((page, index) => {
  for (const line of page.split('\n')) {
    // 行格式：姓名  掩码证件号（末四位可见）  来源编号  公告日期
    const m = line.match(/^\s*([\p{Script=Han}·]{2,20})\s+\*{6,14}(\d{3}[0-9Xx])\s+([A-Z0-9-]{4,40})\s+(\d{4}-\d{2}-\d{2})\s*$/u);
    if (m) rows.push([m[1], m[2].toUpperCase(), m[3], index + 1, m[4]]);
  }
});
if (!rows.length) { console.error('没有识别到符合版式的行，请检查 PDF 是否带文本层、版式是否与规则一致'); process.exit(1); }
console.log('name,tail4,source_ref,source_page,notice_date');
for (const row of rows) console.log(row.join(','));
console.error(`已提取 ${rows.length} 行（第 ${rows[0][3]}–${rows.at(-1)[3]} 页）`);
