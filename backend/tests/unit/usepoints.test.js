require("./helpers");
const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeClient, useFakeTransaction, invoke } = require("./helpers");
const db = require("../../src/db");
const { usePoints } = require("../../src/controllers/usepoints.controller");

function client({ order = { id: "o1", status: "served", user_id: "u1" }, balanceOk = true } = {}) {
  return new FakeClient([
    [/^SELECT \* FROM orders .* FOR UPDATE$/, () => ({ rows: order ? [order] : [] })],
    [/^UPDATE users SET total_points = total_points - \$1/, () => ({ rowCount: balanceOk ? 1 : 0 })],
  ]);
}

async function use(c, { points = 100, customer = { userId: "u1" } } = {}) {
  const restore = useFakeTransaction(db, c);
  try {
    return await invoke(usePoints, { params: { id: "o1" }, body: { points }, customer });
  } finally {
    restore();
  }
}

for (const bad of [0, -5, 1.5, "abc", null]) {
  test(`số điểm không hợp lệ (${JSON.stringify(bad)}) → 400`, async () => {
    const { res } = await use(client(), { points: bad });
    assert.equal(res.statusCode, 400);
  });
}

test("chưa đăng nhập → 401", async () => {
  const { res } = await use(client(), { customer: null });
  assert.equal(res.statusCode, 401);
});

test("khoá dòng đơn trước khi trừ điểm", async () => {
  const c = client();
  await use(c);
  assert.ok(c.indexOf(/FROM orders .* FOR UPDATE/) < c.indexOf(/^UPDATE users/));
});

test("trừ điểm bằng MỘT câu UPDATE có điều kiện số dư (nguyên tử), không đọc số dư trước", async () => {
  const c = client();
  const { res } = await use(c, { points: 100 });
  assert.equal(res.statusCode, 200);
  assert.equal(c.count(/^SELECT total_points/), 0);
  const spend = c.queries.find((q) => /^UPDATE users/.test(q.sql));
  assert.match(spend.sql, /AND total_points >= \$1$/);
  assert.deepEqual(spend.params, [100, "u1"]);
  assert.equal(c.count(/^UPDATE orders SET discount_amount/), 1);
});

test("không đủ điểm (UPDATE không khớp dòng nào) → 400, không giảm giá", async () => {
  const c = client({ balanceOk: false });
  const { err } = await use(c);
  assert.equal(err.status, 400);
  assert.equal(c.count(/^UPDATE orders SET discount_amount/), 0);
});

test("đơn của người khác → 403, không trừ điểm", async () => {
  const c = client({ order: { id: "o1", status: "served", user_id: "someone-else" } });
  const { err } = await use(c);
  assert.equal(err.status, 403);
  assert.equal(c.count(/^UPDATE/), 0);
});

test("đơn đã thanh toán → 400", async () => {
  const { err } = await use(client({ order: { id: "o1", status: "paid", user_id: "u1" } }));
  assert.equal(err.status, 400);
});

test("đơn không tồn tại → 404", async () => {
  const { err } = await use(client({ order: null }));
  assert.equal(err.status, 404);
});
