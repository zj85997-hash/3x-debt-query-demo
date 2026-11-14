// 生成并导入虚构演示数据：约 45 万笔自有资产、
// 5.5 万条历史转让记录、1 万条脱敏公告候选。全部由 src/domain/synth.mjs 的确定性规则生成，不含任何真实个人信息。
import {createHash} from 'node:crypto';
import mysql from 'mysql2/promise';
import {config} from '../src/config.mjs';
import {idHash, pairHash, maskName, maskId} from '../src/infra/crypto.mjs';
import {SEG, personOf, assetsOf, transfersOf, candidatesOf} from '../src/domain/synth.mjs';

const SEED_VERSION = '2';
const {db} = config;
const fingerprint = createHash('sha256').update(idHash('fingerprint')).digest('hex').slice(0, 16);
const connection = await mysql.createConnection({
  ...(db.socketPath ? {socketPath: db.socketPath} : {host: db.host, port: db.port}),
  user: db.user, password: db.password, database: db.database, charset: 'utf8mb4'
});
const insert = async (sql, rows) => { if (rows.length) await connection.query(sql, [rows]); };
const started = Date.now();
try {
  const [meta] = await connection.query("SELECT k, v FROM app_meta WHERE k IN ('seed_version','id_hash_fp')");
  const current = Object.fromEntries(meta.map(r => [r.k, r.v]));
  if (current.seed_version === SEED_VERSION && current.id_hash_fp === fingerprint && process.argv[2] !== '--force') {
    console.log('演示数据已是最新，跳过导入（如需重建：npm run seed -- --force）');
  } else {
    console.log('开始导入演示数据…');
    for (const t of ['assets', 'transfer_records', 'notice_candidates', 'import_batches']) await connection.query('TRUNCATE TABLE ' + t);
    await connection.query('SET SESSION unique_checks=0, foreign_key_checks=0');
    await connection.query("INSERT INTO import_batches (id, kind, source, status) VALUES (1,'assets','虚构演示台账',1),(2,'transfers','虚构演示转让记录',1),(3,'candidates','虚构演示公告候选',1)");
    const CHUNK = 4000;
    let assets = [], transfers = [], candidates = [];
    let nAssets = 0, nTransfers = 0, nCandidates = 0;
    const flush = async (force) => {
      if (assets.length >= CHUNK || (force && assets.length)) {
        await insert('INSERT INTO assets (id,debt_no,package_no,id_hash,name_masked,id_masked,holder,originator,loan_date,principal_fen,balance_fen,as_of,mandate_status,batch_id) VALUES ?', assets);
        nAssets += assets.length; assets = [];
      }
      if (transfers.length >= CHUNK || (force && transfers.length)) {
        await insert('INSERT INTO transfer_records (id,id_hash,name_masked,id_masked,transferor,transferee,transfer_date,amount_fen,notice_ref,contact,status,batch_id) VALUES ?', transfers);
        nTransfers += transfers.length; transfers = [];
      }
      if (candidates.length >= CHUNK || (force && candidates.length)) {
        await insert('INSERT INTO notice_candidates (id,pair_hash,source_ref,source_page,notice_date,status,batch_id) VALUES ?', candidates);
        nCandidates += candidates.length; candidates = [];
      }
    };
    for (let i = 0; i < SEG.expired[1]; i++) {
      const {name, idNo} = personOf(i);
      const owned = assetsOf(i), moved = transfersOf(i), hints = candidatesOf(i);
      if (owned.length || moved.length) {
        const hash = idHash(idNo), nameMasked = maskName(name), idMasked = maskId(idNo);
        owned.forEach((a, k) => assets.push([1e9 + i * 2 + k, a.debtNo, a.packageNo, hash, nameMasked, idMasked, a.holder, a.originator, a.loanDate, a.principalFen, a.balanceFen, a.asOf, a.mandateStatus, 1]));
        moved.forEach((t, k) => transfers.push([2e9 + i * 2 + k, hash, nameMasked, idMasked, t.transferor, t.transferee, t.transferDate, t.amountFen, t.noticeRef, t.contact, 1, 2]));
      }
      if (hints.length) {
        const hash = pairHash(name, idNo.slice(-4));
        hints.forEach((c, k) => candidates.push([3e9 + i * 2 + k, hash, c.sourceRef, c.sourcePage, c.noticeDate, 1, 3]));
      }
      if (i % 2000 === 0) await flush(false);
    }
    await flush(true);
    await connection.query('UPDATE import_batches SET row_count = CASE id WHEN 1 THEN ? WHEN 2 THEN ? ELSE ? END', [nAssets, nTransfers, nCandidates]);
    await connection.query("REPLACE INTO app_meta (k, v) VALUES ('seed_version', ?), ('id_hash_fp', ?)", [SEED_VERSION, fingerprint]);
    await connection.query('ANALYZE TABLE assets, transfer_records, notice_candidates');
    console.log(`导入完成：自有资产 ${nAssets} 笔，历史转让 ${nTransfers} 条，公告候选 ${nCandidates} 条，用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
  }
} finally { await connection.end(); }
