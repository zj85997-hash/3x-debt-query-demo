import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';

const source=new URL('../fixtures/债权转让通知-虚构样本.pdf',import.meta.url);
const text=execFileSync('pdftotext',['-layout',decodeURIComponent(source.pathname),'-'],{encoding:'utf8',timeout:5000});
assert(text.includes('债权转让通知 虚构样本'),'Expected the marked synthetic fixture');
const rows=[];
for(const line of text.split('\n')){
  const row=line.match(/^\s*(样例[\p{Script=Han}]{1,8})\s+\*{14}(\d{3}[0-9X])\s+(DEMO-FIX-\d{3})\s+(\d{4}-\d{2}-\d{2})\s*$/u);
  if(row)rows.push({name:row[1],tail4:row[2],sourceRef:row[3],noticeDate:row[4],page:1});
  else if(line.trimStart().startsWith('样例'))throw Error('Malformed synthetic row');
}
assert.equal(rows.length,5);
assert.equal(new Set(rows.map(r=>r.sourceRef)).size,rows.length);
await writeFile(new URL('../fixtures/notice-candidates.json',import.meta.url),JSON.stringify(rows,null,2)+'\n');
console.log('已从虚构 PDF 提取 '+rows.length+' 行');
