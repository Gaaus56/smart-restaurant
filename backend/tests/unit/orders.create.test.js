require("./helpers");
const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeClient, useFakeTransaction, invoke } = require("./helpers");
const db = require("../../src/db");
const orders = require("../../src/controllers/orders.controller");

const MENU = { m1: { price: "45000", name: "Phở bò" }, m2: { price: "30000", name: "Trà đào" } };

function client({ tableExists = true, openOrder = null } = {}) {
  return new FakeClient([
    [/^SELECT id, table_number FROM tables .* FOR UPDATE$/, () => ({ rows: tableExists ? [{ id: "t1", table_number: "B05" }] : [] })],
    [/^SELECT id, total_amount, user_id FROM orders/, () => ({ rows: openOrder ? [openOrder] : [] })],
    [/^INSERT INTO orders/, () => ({ rows: [{ id: "new-order", created_at: new Date() }] })],
    [/^SELECT price, name FROM menu_items/, ([id]) => ({ rows: MENU[id] ? [MENU[id]] : [] })],
  ]);
}

async function create(c, body, customer) {
  const restore = useFakeTransaction(db, c);
  try {
    return await invoke(orders.create, { body, customer });
  } finally {
    restore();
  }
}

test("thiếu tableId → 400, không mở giao dịch", async () => {
  const c = client();
  const { res } = await create(c, { items: [] });
  assert.equal(res.statusCode, 400);
  assert.equal(c.queries.length, 0);
});

test("request không có body → 400 thay vì làm sập tiến trình", async () => {
  const { res } = await invoke(orders.create, {});
  assert.equal(res.statusCode, 400);
});

test("câu SQL đầu tiên là khoá dòng của bàn (chống tạo đơn trùng khi gọi món đồng thời)", async () => {
  const c = client();
  await create(c, { tableId: "t1", items: [{ itemId: "m1", quantity: 1 }] });
  assert.match(c.queries[0].sql, /^SELECT id, table_number FROM tables WHERE id = \$1 FOR UPDATE$/);
});

test("bàn không tồn tại → lỗi 404 chuyển cho errorHandler", async () => {
  const { err } = await create(client({ tableExists: false }), { tableId: "x", items: [] });
  assert.equal(err.status, 404);
});

test("bàn chưa có đơn mở → tạo đơn mới", async () => {
  const c = client();
  const { res } = await create(c, { tableId: "t1", items: [{ itemId: "m1", quantity: 2 }] });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.is_new_order, true);
  assert.equal(res.body.data.total, 90000);
  assert.equal(c.count(/^INSERT INTO orders/), 1);
});

test("bàn đã có đơn mở → gộp món vào đơn đó, không tạo đơn mới", async () => {
  const c = client({ openOrder: { id: "open-1", total_amount: "45000", user_id: "u1" } });
  const { res } = await create(c, { tableId: "t1", items: [{ itemId: "m2", quantity: 1 }] });
  assert.equal(res.body.data.order_id, "open-1");
  assert.equal(res.body.data.is_new_order, false);
  assert.equal(c.count(/^INSERT INTO orders/), 0);
  const add = c.queries.find((q) => /^UPDATE orders SET total_amount = total_amount \+ \$1/.test(q.sql));
  assert.deepEqual(add.params, [30000, "open-1"]);
});

test("giá lấy từ CSDL, bỏ qua giá client gửi lên; cộng giá tuỳ chọn món", async () => {
  const c = client();
  const { res } = await create(c, {
    tableId: "t1",
    items: [{ itemId: "m1", quantity: 2, price: 1, modifiers: [{ name: "Thêm bò", price: "10000" }] }],
  });
  assert.equal(res.body.data.total, 110000); // (45.000 + 10.000) × 2 — không phải 1đ
  const line = c.queries.find((q) => /^INSERT INTO order_items/.test(q.sql));
  assert.equal(line.params[3], 45000); // price_per_unit
  assert.equal(line.params[4], 110000); // total_price
});

test("món không tồn tại → lỗi 400, không ghi order_items", async () => {
  const c = client();
  const { err } = await create(c, { tableId: "t1", items: [{ itemId: "ghost", quantity: 1 }] });
  assert.equal(err.status, 400);
  assert.equal(c.count(/^INSERT INTO order_items/), 0);
});

test("đơn mở chưa gắn khách + khách đã đăng nhập → gắn user_id vào đơn", async () => {
  const c = client({ openOrder: { id: "open-1", total_amount: "0", user_id: null } });
  await create(c, { tableId: "t1", items: [] }, { userId: "u9" });
  const attach = c.queries.find((q) => /^UPDATE orders SET user_id/.test(q.sql));
  assert.deepEqual(attach.params, ["u9", "open-1"]);
});
