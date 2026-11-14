/**
 * Concurrency test harness — gửi các request THỰC SỰ đồng thời vào API đang chạy
 * rồi kiểm tra bất biến (invariant) trực tiếp trong PostgreSQL.
 *
 * Chạy:  API_URL=http://localhost:4000 DATABASE_URL=postgres://... JWT_SECRET=... \
 *        STRIPE_WEBHOOK_SECRET=whsec_... node tests/concurrency/run.js [--json out.json]
 *
 * Kịch bản:
 *   A. duplicate-orders   N bàn × M request gọi món cùng lúc  → mỗi bàn chỉ được có 1 đơn mở
 *   B. webhook-replay     cùng 1 sự kiện Stripe gửi lại M lần → chỉ cộng điểm 1 lần
 *   C. cash-double-pay    nhân viên bấm "thanh toán" M lần    → chỉ cộng điểm 1 lần
 *   D. points-overspend   khách dùng toàn bộ điểm M lần       → điểm không âm, chỉ trừ 1 lần
 *
 * Mỗi request mang một X-Forwarded-For khác nhau (mô phỏng nhiều khách ở nhiều thiết bị),
 * nên rate limiter theo IP không che mất lỗi đồng thời.
 */
require("dotenv").config();
const crypto = require("crypto");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const API_URL = process.env.API_URL || "http://localhost:4000";
const TABLES = Number(process.env.TABLES || 10);
const BURST = Number(process.env.BURST || 20);
const REPLAYS = Number(process.env.REPLAYS || 10);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const ONLY = (process.env.SCENARIOS || "A,B,C,D").split(",").map((s) => s.trim().toUpperCase());
const ORDER_TOTAL = 500000; // 500.000đ → 50 điểm (1 điểm / 10.000đ)
const EXPECTED_POINTS = Math.floor(ORDER_TOTAL / 10000);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const runId = `cc${Date.now().toString(36)}`;
let ipSeq = 0;

function nextIp() {
  ipSeq += 1;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
}

async function call(method, path, { body, headers = {}, raw } = {}) {
  const started = performance.now();
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-forwarded-for": nextIp(), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Request không nhận được phản hồi trong REQUEST_TIMEOUT_MS → server bị treo (vd. cạn connection pool).
    return { status: "timeout", body: err.name, ms: performance.now() - started };
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, ms: performance.now() - started };
}

function statusCounts(results) {
  return results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
}

// ─────────────────────────── Fixtures ───────────────────────────

async function createTable(label) {
  const { rows } = await pool.query(
    "INSERT INTO tables (table_number, capacity, location, status) VALUES ($1, 4, 'Concurrency test', 'active') RETURNING id, table_number",
    [`${runId}-${label}`]
  );
  return rows[0];
}

async function createGuest(label, points) {
  const { rows } = await pool.query(
    "INSERT INTO users (email, full_name, role, status, total_points) VALUES ($1, $2, 'guest', 'active', $3) RETURNING id, email",
    [`${runId}-${label}@test.local`, `Test ${label}`, points]
  );
  return rows[0];
}

async function createServedOrder(tableId, userId) {
  const { rows } = await pool.query(
    "INSERT INTO orders (table_id, user_id, customer_name, status, total_amount) VALUES ($1, $2, 'Concurrency test', 'served', $3) RETURNING id",
    [tableId, userId, ORDER_TOTAL]
  );
  return rows[0].id;
}

async function anyMenuItem() {
  const { rows } = await pool.query(
    "SELECT id, price FROM menu_items WHERE deleted_at IS NULL AND status = 'available' ORDER BY name LIMIT 1"
  );
  if (rows.length === 0) throw new Error("Không có món ăn nào trong DB — hãy chạy seed trước.");
  return { id: rows[0].id, price: Number(rows[0].price) };
}

async function points(userId) {
  const { rows } = await pool.query("SELECT total_points FROM users WHERE id = $1", [userId]);
  return Number(rows[0].total_points);
}

// ─────────────────────────── Scenarios ───────────────────────────

async function scenarioDuplicateOrders() {
  const item = await anyMenuItem();
  const tables = [];
  for (let i = 0; i < TABLES; i += 1) tables.push(await createTable(`A${i}`));

  const requests = [];
  for (const table of tables) {
    for (let j = 0; j < BURST; j += 1) {
      requests.push(
        call("POST", "/api/orders", {
          body: { tableId: table.id, items: [{ itemId: item.id, quantity: 1 }] },
        })
      );
    }
  }
  const results = await Promise.all(requests);

  const tableIds = tables.map((t) => t.id);
  const { rows } = await pool.query(
    `SELECT o.table_id, COUNT(*)::int AS open_orders
       FROM orders o
      WHERE o.table_id = ANY($1) AND o.status NOT IN ('paid', 'cancelled')
      GROUP BY o.table_id`,
    [tableIds]
  );
  const { rows: money } = await pool.query(
    `SELECT COALESCE(SUM(oi.quantity), 0)::int AS items,
            COALESCE(SUM(oi.total_price), 0)::numeric AS items_total,
            (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE table_id = ANY($1))::numeric AS orders_total
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.table_id = ANY($1)`,
    [tableIds]
  );

  const openOrders = rows.reduce((sum, r) => sum + r.open_orders, 0);
  const created = results.filter((r) => r.status === 201).length;
  const duplicates = openOrders - tables.length;
  const tablesWithDuplicates = rows.filter((r) => r.open_orders > 1).length;
  const itemsSaved = money[0].items;
  const totalsMatch = Number(money[0].items_total) === Number(money[0].orders_total);

  return {
    name: "A. duplicate-orders",
    requests: results.length,
    http: statusCounts(results),
    p95ms: percentile(results.map((r) => r.ms), 95),
    metrics: {
      tables: tables.length,
      timedOut: results.filter((r) => r.status === "timeout").length,
      openOrders,
      duplicateOrders: duplicates,
      tablesWithDuplicates,
      itemsSaved: `${itemsSaved}/${created}`,
      totalsMatch,
    },
    pass: created === results.length && duplicates === 0 && itemsSaved === created && totalsMatch,
  };
}

function signStripe(payload, secret) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${payload}`).digest("hex");
  return `t=${ts},v1=${sig}`;
}

async function scenarioWebhookReplay() {
  const table = await createTable("B");
  const guest = await createGuest("B", 0);
  const orderId = await createServedOrder(table.id, guest.id);

  const payload = JSON.stringify({
    id: `evt_${runId}`,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_test_${runId}`,
        object: "checkout.session",
        payment_status: "paid",
        metadata: { orderId, tableId: table.id, tableNumber: table.table_number },
      },
    },
  });
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const results = await Promise.all(
    Array.from({ length: REPLAYS }, () =>
      call("POST", "/api/payment/stripe/webhook", {
        raw: payload,
        headers: secret ? { "stripe-signature": signStripe(payload, secret) } : {},
      })
    )
  );

  const finalPoints = await points(guest.id);
  const { rows } = await pool.query("SELECT status FROM orders WHERE id = $1", [orderId]);
  return {
    name: "B. webhook-replay",
    requests: results.length,
    http: statusCounts(results),
    p95ms: percentile(results.map((r) => r.ms), 95),
    metrics: {
      signed: Boolean(secret),
      orderStatus: rows[0].status,
      pointsExpected: EXPECTED_POINTS,
      pointsActual: finalPoints,
      timesAwarded: finalPoints / EXPECTED_POINTS,
    },
    pass: rows[0].status === "paid" && finalPoints === EXPECTED_POINTS,
  };
}

async function scenarioCashDoublePay() {
  const table = await createTable("C");
  const guest = await createGuest("C", 0);
  const orderId = await createServedOrder(table.id, guest.id);

  const results = await Promise.all(
    Array.from({ length: REPLAYS }, () =>
      call("POST", `/api/payment/orders/${orderId}/pay`, { body: { method: "cash" } })
    )
  );

  const finalPoints = await points(guest.id);
  return {
    name: "C. cash-double-pay",
    requests: results.length,
    http: statusCounts(results),
    p95ms: percentile(results.map((r) => r.ms), 95),
    metrics: {
      pointsExpected: EXPECTED_POINTS,
      pointsActual: finalPoints,
      timesAwarded: finalPoints / EXPECTED_POINTS,
    },
    pass: finalPoints === EXPECTED_POINTS,
  };
}

async function scenarioPointsOverspend() {
  const STARTING_POINTS = 100;
  const table = await createTable("D");
  const guest = await createGuest("D", STARTING_POINTS);
  const orderId = await createServedOrder(table.id, guest.id);
  const token = jwt.sign(
    { userId: guest.id, email: guest.email, role: "guest" },
    process.env.JWT_SECRET || "secret",
    { expiresIn: "10m" }
  );

  const results = await Promise.all(
    Array.from({ length: REPLAYS }, () =>
      call("PATCH", `/api/orders/${orderId}/use-points`, {
        body: { points: STARTING_POINTS },
        headers: { authorization: `Bearer ${token}` },
      })
    )
  );

  const finalPoints = await points(guest.id);
  const { rows } = await pool.query("SELECT discount_amount FROM orders WHERE id = $1", [orderId]);
  const discount = Number(rows[0].discount_amount);
  const accepted = results.filter((r) => r.status === 200).length;
  return {
    name: "D. points-overspend",
    requests: results.length,
    http: statusCounts(results),
    p95ms: percentile(results.map((r) => r.ms), 95),
    metrics: {
      startingPoints: STARTING_POINTS,
      acceptedRequests: accepted,
      pointsAfter: finalPoints,
      discountGranted: discount,
    },
    pass: accepted === 1 && finalPoints === 0 && discount === STARTING_POINTS,
  };
}

// ─────────────────────────── Runner ───────────────────────────

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[idx]);
}

async function cleanup() {
  await pool.query(
    "DELETE FROM orders WHERE table_id IN (SELECT id FROM tables WHERE table_number LIKE $1)",
    [`${runId}-%`]
  );
  await pool.query("DELETE FROM tables WHERE table_number LIKE $1", [`${runId}-%`]);
  await pool.query("DELETE FROM users WHERE email LIKE $1", [`${runId}-%`]);
}

async function main() {
  const health = await fetch(`${API_URL}/health`).catch(() => null);
  if (!health || !health.ok) throw new Error(`API không phản hồi tại ${API_URL}/health`);

  const all = { A: scenarioDuplicateOrders, B: scenarioWebhookReplay, C: scenarioCashDoublePay, D: scenarioPointsOverspend };
  const scenarios = ONLY.map((key) => all[key]).filter(Boolean);
  const report = [];
  try {
    for (const scenario of scenarios) {
      const result = await scenario();
      report.push(result);
      console.log(`\n${result.pass ? "PASS" : "FAIL"}  ${result.name}  (${result.requests} request đồng thời, p95 ${result.p95ms} ms)`);
      console.log(`      HTTP: ${JSON.stringify(result.http)}`);
      for (const [key, value] of Object.entries(result.metrics)) console.log(`      ${key}: ${value}`);
    }
  } finally {
    if (!process.env.KEEP_DATA) await cleanup();
    await pool.end();
  }

  const jsonIdx = process.argv.indexOf("--json");
  if (jsonIdx > -1) fs.writeFileSync(process.argv[jsonIdx + 1], JSON.stringify({ runId, report }, null, 2));

  const failed = report.filter((r) => !r.pass).length;
  console.log(`\n${report.length - failed}/${report.length} kịch bản đạt.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
