require("./helpers");
const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeClient } = require("./helpers");
const { markOrderPaid } = require("../../src/services/payment.service");

const TABLE = { id: "t1", table_number: "B05" };

function client({ status = "served", userId = "u1", total = "523000", tableId = TABLE.id, exists = true } = {}) {
  const order = { id: "o1", table_id: tableId, user_id: userId, status, total_amount: total };
  return new FakeClient([
    [/^SELECT table_id FROM orders/, () => ({ rows: exists ? [{ table_id: tableId }] : [] })],
    [/^SELECT table_number FROM tables .* FOR UPDATE$/, () => ({ rows: [{ table_number: TABLE.table_number }] })],
    [/^SELECT \* FROM orders .* FOR UPDATE$/, () => ({ rows: [order] })],
    [/^UPDATE orders SET status = 'paid'/, () => ({ rows: [{ ...order, status: "paid" }] })],
  ]);
}

test("khoá BÀN trước rồi mới khoá ĐƠN (cùng thứ tự với luồng gọi món — tránh deadlock)", async () => {
  const c = client();
  await markOrderPaid(c, "o1");
  const tableLock = c.indexOf(/FROM tables .* FOR UPDATE/);
  const orderLock = c.indexOf(/FROM orders .* FOR UPDATE/);
  assert.ok(tableLock >= 0 && orderLock >= 0, "phải khoá cả bàn và đơn");
  assert.ok(tableLock < orderLock, "khoá bàn phải đứng trước khoá đơn");
});

test("thanh toán lần đầu: chuyển 'paid', cộng điểm 1 điểm / 10.000đ, giải phóng bàn", async () => {
  const c = client();
  const result = await markOrderPaid(c, "o1");
  assert.equal(result.alreadyPaid, false);
  assert.equal(result.pointsAwarded, 52); // 523.000đ → 52 điểm (làm tròn xuống)
  assert.equal(result.tableNumber, "B05");
  const points = c.queries.find((q) => /^UPDATE users SET total_points/.test(q.sql));
  assert.deepEqual(points.params, [52, "u1"]);
  assert.equal(c.count(/^UPDATE tables SET status = 'active'/), 1);
});

test("đơn đã thanh toán: idempotent — không cập nhật gì, không cộng điểm lần 2", async () => {
  const c = client({ status: "paid" });
  const result = await markOrderPaid(c, "o1");
  assert.equal(result.alreadyPaid, true);
  assert.equal(result.pointsAwarded, 0);
  assert.equal(c.count(/^UPDATE/), 0);
});

test("đơn đã huỷ: lỗi 409, không cập nhật", async () => {
  const c = client({ status: "cancelled" });
  await assert.rejects(markOrderPaid(c, "o1"), (err) => err.status === 409);
  assert.equal(c.count(/^UPDATE/), 0);
});

test("đơn không tồn tại: lỗi 404, không khoá gì", async () => {
  const c = client({ exists: false });
  await assert.rejects(markOrderPaid(c, "nope"), (err) => err.status === 404);
  assert.equal(c.count(/FOR UPDATE/), 0);
});

test("khách vãng lai (không user_id): không cộng điểm", async () => {
  const c = client({ userId: null });
  const result = await markOrderPaid(c, "o1");
  assert.equal(result.pointsAwarded, 0);
  assert.equal(c.count(/^UPDATE users/), 0);
});

test("đơn dưới 10.000đ: không cộng điểm", async () => {
  const c = client({ total: "9999" });
  assert.equal((await markOrderPaid(c, "o1")).pointsAwarded, 0);
  assert.equal(c.count(/^UPDATE users/), 0);
});

test("đơn không gắn bàn: không khoá/giải phóng bàn", async () => {
  const c = client({ tableId: null });
  const result = await markOrderPaid(c, "o1");
  assert.equal(result.tableNumber, null);
  assert.equal(c.count(/tables/), 0);
});
