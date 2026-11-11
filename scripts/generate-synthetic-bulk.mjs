import {writeFile} from 'node:fs/promises';

const rows = Array.from({length:10000}, (_, index)=>{
  const number = index + 1;
  const repeated = number % 500 === 0;
  const name = '样例*' + String(repeated ? 0 : number).padStart(5,'0');
  const tail4 = repeated ? '0042' : String(number % 10000).padStart(4,'0');
  return {
    name,
    maskedIdentity:'*'.repeat(14)+tail4,
    tail4,
    sourceRef:'DEMO-BULK-'+String(number).padStart(5,'0'),
    noticeDate:'2025-01-01',
    page:Math.ceil(number/25)
  };
});
await writeFile(new URL('../docs/data/synthetic-bulk.json',import.meta.url),JSON.stringify(rows)+'\n');
console.log('Generated '+rows.length+' entirely synthetic candidate rows.');
