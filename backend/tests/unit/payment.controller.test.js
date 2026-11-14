require("./helpers");
const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeClient, useFakeTransaction, invoke, stripeSignature } = require("./helpers");
const db = require("../../src/db");
const payment = require("../../src/controllers/payment.controller");

function paymentClient(status = "served") {
  const order = { id: "o1", table_id: "t1", user_id: "u1", status, total_amount: "100000" };
  return new FakeClient([
    [/^SELECT table_id FROM orders/, () => ({ rows: [{ table_id: "t1" }] })],
    [/^SELECT table_number FROM tables/, () => ({ rows: [{ table_number: "B05" }] })],
    [/^SELECT \* FROM orders .* FOR UPDATE$/, () => ({ rows: [order] })],
    [/^UPDATE orders SET status = 'paid'/, () => ({ rows: [{ ...order, status: "paid" }] })],
  ]);
}

async function withFake(c, fn) {
  const restore = useFakeTransaction(db, c);
  try {
    return await fn();
  } finally {
    restore();
  }
}

function event({ paymentStatus = "paid", orderId = "o1" } = {}) {
  return JSON.stringify({
    id: "evt_1",
    object: "event",
    type: "checkout.session.completed",
    data: { object: { id: "cs_1", payment_status: paymentStatus, metadata: { orderId } } },
  });
}

/** signature: chuỗi chữ ký; mặc định ký đúng; `null` = không gửi header Stripe-Signature. */
function webhookReq(payload, signature = stripeSignature(payload)) {
  const headers = signature === null ? {} : { "stripe-signature": signature };
  return { headers, body: Buffer.from(payload) };
}

// ─────────── Thanh toán tiền mặt ───────────

test("thanh toán tiền mặt lần đầu → 'Payment successful'", async () => {
  const { res } = await withFake(paymentClient(), () =>
    invoke(payment.processPayment, { params: { id: "o1" }, body: { method: "cash" } })
  );
  assert.equal(res.body.message, "Payment successful");
});

test("bấm thanh toán lần 2 → 200 'already paid', không cập nhật gì", async () => {
  const c = paymentClient("paid");
  const { res } = await withFake(c, () => invoke(payment.processPayment, { params: { id: "o1" }, body: {} }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.alreadyPaid, true);
  assert.equal(c.count(/^UPDATE/), 0);
});

test("VietQR thiếu orderId → 400", async () => {
  const { res } = await invoke(payment.confirmVietQR, { body: {} });
  assert.equal(res.statusCode, 400);
});

// ─────────── Webhook Stripe ───────────

test("webhook không có chữ ký → 400, không chạm CSDL", async () => {
  const c = paymentClient();
  const { res } = await withFake(c, () => invoke(payment.handleStripeWebhook, webhookReq(event(), null)));
  assert.equal(res.statusCode, 400);
  assert.equal(c.queries.length, 0);
});

test("webhook ký bằng secret sai → 400", async () => {
  const payload = event();
  const { res } = await invoke(payment.handleStripeWebhook, webhookReq(payload, stripeSignature(payload, "whsec_wrong")));
  assert.equal(res.statusCode, 400);
});

test("webhook bị sửa nội dung sau khi ký → 400", async () => {
  const signature = stripeSignature(event({ orderId: "o1" }));
  const { res } = await invoke(payment.handleStripeWebhook, webhookReq(event({ orderId: "o2" }), signature));
  assert.equal(res.statusCode, 400);
});

test("webhook hợp lệ → đánh dấu đã thanh toán, trả { received: true }", async () => {
  const c = paymentClient();
  const { res } = await withFake(c, () => invoke(payment.handleStripeWebhook, webhookReq(event())));
  assert.deepEqual(res.body, { received: true });
  assert.equal(c.count(/^UPDATE orders SET status = 'paid'/), 1);
});

test("webhook gửi lại cho đơn đã thanh toán → vẫn 200, không cập nhật lần 2", async () => {
  const c = paymentClient("paid");
  const { res } = await withFake(c, () => invoke(payment.handleStripeWebhook, webhookReq(event())));
  assert.deepEqual(res.body, { received: true });
  assert.equal(c.count(/^UPDATE/), 0);
});

test("phiên thanh toán chưa 'paid' → bỏ qua", async () => {
  const c = paymentClient();
  await withFake(c, () => invoke(payment.handleStripeWebhook, webhookReq(event({ paymentStatus: "unpaid" }))));
  assert.equal(c.queries.length, 0);
});

test("lỗi CSDL bất ngờ → 500 để Stripe gửi lại", async () => {
  const broken = new FakeClient([[/.*/, () => { throw new Error("connection lost"); }]]);
  const { res } = await withFake(broken, () => invoke(payment.handleStripeWebhook, webhookReq(event())));
  assert.equal(res.statusCode, 500);
});

test("đơn không tồn tại (lỗi vĩnh viễn) → 200 để Stripe không gửi lại vô ích", async () => {
  const missing = new FakeClient([[/^SELECT table_id FROM orders/, () => ({ rows: [] })]]);
  const { res } = await withFake(missing, () => invoke(payment.handleStripeWebhook, webhookReq(event())));
  assert.deepEqual(res.body, { received: true });
});
