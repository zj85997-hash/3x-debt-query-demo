import mysql from 'mysql2/promise';

export const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 33326),
  ...(process.env.DB_SOCKET ? {socketPath:process.env.DB_SOCKET} : {}),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: 'debt_demo',
  connectionLimit: 12,
  queueLimit: 512,
  connectTimeout: 2500,
  enableKeepAlive: true,
  dateStrings: true,
  ...(process.env.DB_CA_FILE ? {ssl: {ca: (await import('node:fs')).readFileSync(process.env.DB_CA_FILE)}} : {})
});
export async function query(sql, args = []) {
  const [rows] = await pool.execute({sql, timeout: 3000}, args);
  return rows;
}
