// 数据库迁移：按文件名顺序执行 migrations/*.sql，已执行的版本记录在 schema_migrations 表，重复运行安全。
import {readdir, readFile} from 'node:fs/promises';
import mysql from 'mysql2/promise';
import {config} from '../src/config.mjs';

const {db} = config;
const connection = await mysql.createConnection({
  ...(db.socketPath ? {socketPath: db.socketPath} : {host: db.host, port: db.port}),
  user: db.user, password: db.password, multipleStatements: true, charset: 'utf8mb4'
});
try {
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await connection.query(`USE \`${db.database}\``);
  await connection.query('CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(64) PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))');
  const [done] = await connection.query('SELECT version FROM schema_migrations');
  const applied = new Set(done.map(r => r.version));
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    await connection.query(await readFile(new URL(file, dir), 'utf8'));
    await connection.query('INSERT INTO schema_migrations(version) VALUES (?)', [file]);
    console.log('已执行迁移 ' + file);
  }
} finally { await connection.end(); }
