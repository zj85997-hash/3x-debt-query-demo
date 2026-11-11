import {pool, query} from '../db.mjs';
import {readFile} from 'node:fs/promises';
const scale = Math.max(0, Math.min(500000, Number(process.argv[2] || 450000)));
try {
  await query(`INSERT IGNORE INTO authorized_assets VALUES
    (1,'demo-own','示例资产管理机构','示例贷款机构','2022-05-17',1800000,2268400,'2026-11-10',1),
    (2,'demo-own','示例资产管理机构','示例消费金融机构','2023-08-12',620000,711000,'2026-11-10',1),
    (3,'demo-expired','示例资产管理机构','示例贷款机构','2022-05-17',1800000,2268400,'2026-11-10',0)`);
  await query(`INSERT IGNORE INTO transfer_notices VALUES
    (1,'demo-history','示例银行','示例资产受让机构','2025-09-18',1235000,'verified_history','DEMO-NOTICE-001'),
    (2,'demo-candidate','示例贷款机构甲','示例受让机构甲','2025-10-21',712000,'masked_candidate','DEMO-NOTICE-002'),
    (3,'demo-candidate','示例贷款机构乙','示例受让机构乙','2025-12-08',890000,'masked_candidate','DEMO-NOTICE-003')`);
  for (let start=0; start<scale; start+=10000) {
    const end=Math.min(start+10000,scale);
    const values=Array.from({length:end-start},(_,i)=>{
      const index=start+i;
      return [100+index,'fixture-'+index,'示例资产机构','示例原始机构','2022-01-01',10000,12000,'2026-11-10',1];
    });
    await pool.query('INSERT IGNORE INTO authorized_assets VALUES ?', [values]);
  }
  const fixtureFiles=['../fixtures/notice-candidates.json','../docs/data/synthetic-bulk.json'];
  for(const file of fixtureFiles){
    const candidates=JSON.parse(await readFile(new URL(file,import.meta.url)));
    for(let start=0;start<candidates.length;start+=1000){
      const values=candidates.slice(start,start+1000).map(({sourceRef,name,tail4,noticeDate,page})=>
        [sourceRef,name,tail4,noticeDate,page]);
      if(values.length)await pool.query('INSERT IGNORE INTO synthetic_notice_candidates VALUES ?', [values]);
    }
  }
  const [a] = await query('SELECT COUNT(*) AS records FROM authorized_assets');
  console.log(JSON.stringify(a));
} finally { await pool.end(); }
