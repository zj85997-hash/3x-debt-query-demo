// 数据导入（受控入口）：把一份 CSV 导入为一个"批次"，全程不落明文证件号——
// 读入 → 逐行校验 → 计算盲索引与掩码 → 写库；任何一行不合格则整批不导入，并列出问题行。
//
//   node scripts/import.mjs --kind assets     --file fixtures/samples/assets.csv     --source "资产系统导出 2026-11-10"
//   node scripts/import.mjs --kind transfers  --file fixtures/samples/transfers.csv  --source "已核实转让台账"
//   node scripts/import.mjs --kind candidates --file fixtures/samples/candidates.csv --source "公告候选"
//   node scripts/import.mjs --revoke 7        （撤销第 7 批：该批数据立即停止对外展示）
//   加 --dry-run 只校验不写库。
//
// 演示模式（APP_MODE=demo）下只接受 99 开头的虚构证件号；真实数据必须在获批的受控环境、以 APP_MODE=prod 导入。
import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import mysql from 'mysql2/promise';
import Redis from 'ioredis';
import {config, demoMode} from '../src/config.mjs';
import {idHash, pairHash, maskName, maskId} from '../src/infra/crypto.mjs';
import {nextId} from '../src/infra/ids.mjs';
import {normalizeId, normalizeName, isValidId, isValidName} from '../src/domain/idcard.mjs';
import {isSyntheticId} from '../src/domain/synth.mjs';

const {values: args} = parseArgs({options: {kind: {type: 'string'}, file: {type: 'string'}, source: {type: 'string'}, revoke: {type: 'string'}, 'dry-run': {type: 'boolean', default: false}}});
const {db} = config;
const connection = await mysql.createConnection({...(db.socketPath ? {socketPath: db.socketPath} : {host: db.host, port: db.port}), user: db.user, password: db.password, database: db.database, charset: 'utf8mb4'});

// 数据变更后把"数据版本号"加一：各 API 进程约 2 秒内感知，旧的查询结果缓存随即作废
async function bumpDataVersion() {
  const options = {protocol: 2, connectTimeout: 1500, maxRetriesPerRequest: 0, retryStrategy: () => null};
  const redis = config.redis.socketPath ? new Redis({path: config.redis.socketPath, ...options}) : new Redis(config.redis.url || 'redis://127.0.0.1:6379', options);
  redis.on('error', () => {});
  try {
    await redis.incr(config.redis.prefix + 'dataver');
    await redis.publish(config.redis.prefix + 'flags:changed', 'dataver');   // 即时通知各进程（另有 2 秒轮询兜底）
    return true;
  }
  catch { return false; }
  finally { redis.disconnect(); }
}
const effective = async () => (await bumpDataVersion() ? '已即时通知各进程（最迟 2 秒）对所有查询生效。' : `未能通知缓存（Redis 不可达），最长 ${config.query.resultCacheSec} 秒后生效。`);

// 极简 CSV 解析：支持双引号包裹与 "" 转义，首行为表头
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(v => v !== '')) rows.push(row);
  const header = rows.shift().map(h => h.trim().replace(/^﻿/, ''));
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const fen = v => (/^\d+(\.\d{1,2})?$/.test(v) ? Math.round(Number(v) * 100) : null);
const text = (v, max) => v.length >= 1 && v.length <= max;
function identity(row, problems) {
  const name = normalizeName(row.name), idNo = normalizeId(row.id_no);
  if (!isValidName(name)) problems.push('姓名格式不正确');
  if (!isValidId(idNo)) problems.push('证件号码未通过校验');
  else if (demoMode && !isSyntheticId(idNo)) problems.push('演示模式只接受 99 开头的虚构证件号');
  return {name, idNo};
}
const KINDS = {
  assets: {
    columns: ['debt_no', 'package_no', 'name', 'id_no', 'holder', 'originator', 'loan_date', 'principal_yuan', 'balance_yuan', 'as_of', 'mandate_status'],
    sql: 'INSERT INTO assets (id,debt_no,package_no,id_hash,name_masked,id_masked,holder,originator,loan_date,principal_fen,balance_fen,as_of,mandate_status,batch_id) VALUES ?',
    build(row, problems, batch) {
      const {name, idNo} = identity(row, problems);
      const principal = fen(row.principal_yuan), balance = fen(row.balance_yuan);
      if (!text(row.debt_no, 32)) problems.push('缺少债务编号');
      if (!text(row.holder, 80) || !text(row.originator, 80)) problems.push('缺少债权主体或原贷款方');
      if (!isDate(row.loan_date) || !isDate(row.as_of)) problems.push('日期应为 YYYY-MM-DD');
      if (principal === null || balance === null) problems.push('金额应为非负数，最多两位小数（单位：元）');
      if (!['0', '1'].includes(row.mandate_status)) problems.push('委托状态只能是 1（有效）或 0（已到期）');
      return problems.length ? null : [nextId(), row.debt_no, row.package_no || '-', idHash(idNo), maskName(name), maskId(idNo), row.holder, row.originator, row.loan_date, principal, balance, row.as_of, Number(row.mandate_status), batch];
    }
  },
  transfers: {
    columns: ['name', 'id_no', 'transferor', 'transferee', 'transfer_date', 'amount_yuan', 'notice_ref', 'contact'],
    sql: 'INSERT INTO transfer_records (id,id_hash,name_masked,id_masked,transferor,transferee,transfer_date,amount_fen,notice_ref,contact,status,batch_id) VALUES ?',
    build(row, problems, batch) {
      const {name, idNo} = identity(row, problems);
      const amount = fen(row.amount_yuan);
      if (!text(row.transferor, 80) || !text(row.transferee, 80)) problems.push('缺少出让方或受让方');
      if (!isDate(row.transfer_date)) problems.push('转让日期应为 YYYY-MM-DD');
      if (amount === null) problems.push('转让金额格式不正确');
      if (!text(row.notice_ref, 48) || !text(row.contact, 80)) problems.push('缺少公告编号或联系方式');
      return problems.length ? null : [nextId(), idHash(idNo), maskName(name), maskId(idNo), row.transferor, row.transferee, row.transfer_date, amount, row.notice_ref, row.contact, 1, batch];
    }
  },
  candidates: {
    columns: ['name', 'tail4', 'source_ref', 'source_page', 'notice_date'],
    sql: 'INSERT INTO notice_candidates (id,pair_hash,source_ref,source_page,notice_date,status,batch_id) VALUES ?',
    build(row, problems, batch) {
      const name = normalizeName(row.name), tail4 = normalizeId(row.tail4);
      if (!isValidName(name)) problems.push('姓名格式不正确');
      if (!/^\d{3}[\dX]$/.test(tail4)) problems.push('证件末四位格式不正确');
      if (!text(row.source_ref, 48)) problems.push('缺少公告来源编号');
      if (!/^\d{1,5}$/.test(row.source_page)) problems.push('页码应为数字');
      if (!isDate(row.notice_date)) problems.push('公告日期应为 YYYY-MM-DD');
      return problems.length ? null : [nextId(), pairHash(name, tail4), row.source_ref, Number(row.source_page), row.notice_date, 1, batch];
    }
  }
};

try {
  if (args.revoke) {
    const batch = Number(args.revoke);
    const [[info]] = await connection.query('SELECT kind, status FROM import_batches WHERE id = ?', [batch]);
    if (!info) throw new Error('批次不存在');
    const statement = {assets: 'UPDATE assets SET mandate_status = 0 WHERE batch_id = ?', transfers: 'UPDATE transfer_records SET status = 0 WHERE batch_id = ?', candidates: 'UPDATE notice_candidates SET status = 0 WHERE batch_id = ?'}[info.kind];
    const [result] = await connection.query(statement, [batch]);
    await connection.query('UPDATE import_batches SET status = 0 WHERE id = ?', [batch]);
    console.log(`已撤销第 ${batch} 批（${info.kind}），${result.affectedRows} 条记录停止对外展示，${await effective()}`);
  } else {
    const kind = KINDS[args.kind];
    if (!kind || !args.file || !args.source) throw new Error('用法：--kind assets|transfers|candidates --file <csv> --source "来源说明" [--dry-run]');
    const rows = parseCsv(await readFile(args.file, 'utf8'));
    const missing = kind.columns.filter(c => rows.length && !(c in rows[0]));
    if (missing.length) throw new Error('CSV 缺少列：' + missing.join('、'));
    if (!rows.length) throw new Error('CSV 没有数据行');
    const [[{next}]] = await connection.query('SELECT IFNULL(MAX(id), 0) + 1 AS next FROM import_batches');
    const built = [], bad = [];
    rows.forEach((row, i) => {
      const problems = [];
      const values = kind.build(row, problems, next);
      if (values) built.push(values); else bad.push(`第 ${i + 2} 行：${problems.join('；')}`);
    });
    if (bad.length) {
      console.error(`校验未通过，整批不导入（${bad.length}/${rows.length} 行有问题）：\n` + bad.slice(0, 30).join('\n') + (bad.length > 30 ? `\n… 其余 ${bad.length - 30} 行略` : ''));
      process.exitCode = 1;
    } else if (args['dry-run']) {
      console.log(`校验通过：${built.length} 行可导入（未写库）。`);
    } else {
      await connection.beginTransaction();
      try {
        await connection.query('INSERT INTO import_batches (id, kind, source, row_count, status) VALUES (?,?,?,?,1)', [next, args.kind, args.source, built.length]);
        for (let i = 0; i < built.length; i += 2000) await connection.query(kind.sql, [built.slice(i, i + 2000)]);
        await connection.commit();
        console.log(`已导入第 ${next} 批（${args.kind}）：${built.length} 行，${await effective()}如需撤销：--revoke ${next}`);
      } catch (error) {
        await connection.rollback();
        throw new Error(error.code === 'ER_DUP_ENTRY' ? '存在重复的债务编号，整批未导入：' + error.sqlMessage : error.message);
      }
    }
  }
} catch (error) {
  console.error('导入失败：' + error.message);
  process.exitCode = 1;
} finally { await connection.end(); }
