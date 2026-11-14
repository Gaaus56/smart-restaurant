/**
 * Tạo N bàn trống cho load test và in ra biến môi trường cho k6.
 *   node loadtest/prepare-tables.js 20
 *   node loadtest/prepare-tables.js --report   → đếm bàn có nhiều hơn 1 đơn mở sau khi chạy
 *   node loadtest/prepare-tables.js --cleanup  → xoá dữ liệu load test
 */
require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PREFIX = "LOAD-";

async function prepare(count) {
  const { rows: items } = await pool.query(
    "SELECT id FROM menu_items WHERE deleted_at IS NULL AND status = 'available' ORDER BY name LIMIT 1"
  );
  const ids = [];
  for (let i = 1; i <= count; i += 1) {
    const { rows } = await pool.query(
      "INSERT INTO tables (table_number, capacity, location, status) VALUES ($1, 4, 'Load test', 'active') RETURNING id",
      [`${PREFIX}${Date.now().toString(36)}-${i}`]
    );
    ids.push(rows[0].id);
  }
  console.log(`TABLE_IDS=${ids.join(",")}`);
  console.log(`ITEM_ID=${items[0].id}`);
}

async function report() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS tables,
            COALESCE(SUM(open_orders), 0)::int AS open_orders,
            COUNT(*) FILTER (WHERE open_orders > 1)::int AS tables_with_duplicates
       FROM (SELECT t.id, COUNT(o.id) FILTER (WHERE o.status NOT IN ('paid','cancelled')) AS open_orders
               FROM tables t LEFT JOIN orders o ON o.table_id = t.id
              WHERE t.table_number LIKE $1
              GROUP BY t.id) x`,
    [`${PREFIX}%`]
  );
  console.log(JSON.stringify(rows[0]));
}

async function cleanup() {
  await pool.query("DELETE FROM orders WHERE table_id IN (SELECT id FROM tables WHERE table_number LIKE $1)", [`${PREFIX}%`]);
  await pool.query("DELETE FROM tables WHERE table_number LIKE $1", [`${PREFIX}%`]);
}

const arg = process.argv[2];
(arg === "--report" ? report() : arg === "--cleanup" ? cleanup() : prepare(Number(arg || 20)))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
