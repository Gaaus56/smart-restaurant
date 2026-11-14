const { Pool } = require('pg');
require('dotenv').config();

// SSL Configuration for cloud databases (Render, Railway, etc.)
// rejectUnauthorized: false allows self-signed certificates
const sslConfig = process.env.NODE_ENV === 'production'
  ? { rejectUnauthorized: false }
  : false;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
  max: Number(process.env.PG_POOL_MAX || 10),
  // Hết connection thì báo lỗi sau 5s thay vì chờ vô hạn (trước đây request bị treo vĩnh viễn).
  connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 5000),
});

// Test connection on startup
pool.on('connect', () => {
  console.log('📦 Database connected successfully');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database error:', err);
});

/**
 * Chạy `work(client)` trong một giao dịch trên MỘT connection duy nhất.
 * - COMMIT khi `work` thành công, ROLLBACK khi có lỗi, luôn trả connection về pool.
 * - Mọi truy vấn trong giao dịch phải dùng `client` được truyền vào, không dùng `db.query`:
 *   giữ một connection rồi xin thêm connection khác từ cùng pool sẽ gây deadlock khi pool cạn.
 */
async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Lỗi nghiệp vụ kèm HTTP status, được errorHandler trả về cho client. */
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool: pool,
  withTransaction,
  httpError,
};
