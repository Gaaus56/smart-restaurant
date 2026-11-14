require("./helpers");
const test = require("node:test");
const assert = require("node:assert/strict");
const { validate, load, MIN_SECRET_LENGTH } = require("../../src/config");

const strong = (ch) => ch.repeat(MIN_SECRET_LENGTH);
const valid = { JWT_SECRET: strong("a"), QR_JWT_SECRET: strong("b") };

test("cấu hình hợp lệ không có lỗi", () => {
  assert.deepEqual(validate(valid), []);
});

test("thiếu secret bị từ chối", () => {
  const errors = validate({});
  assert.equal(errors.length, 2);
  assert.match(errors[0], /JWT_SECRET chưa được đặt/);
  assert.match(errors[1], /QR_JWT_SECRET chưa được đặt/);
});

test("giá trị mặc định cũ trong code bị từ chối", () => {
  const errors = validate({ JWT_SECRET: "secret", QR_JWT_SECRET: "qr_secret_key" });
  assert.equal(errors.length, 2);
  for (const e of errors) assert.match(e, /giá trị mẫu\/mặc định/);
});

test("giá trị mẫu trong file .env.example bị từ chối", () => {
  const errors = validate({ ...valid, JWT_SECRET: "smart-restaurant-jwt-secret-key-2024" });
  assert.equal(errors.length, 1);
});

test(`secret ngắn hơn ${MIN_SECRET_LENGTH} ký tự bị từ chối`, () => {
  const errors = validate({ ...valid, QR_JWT_SECRET: "x".repeat(MIN_SECRET_LENGTH - 1) });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ít nhất/);
});

test("hai secret trùng nhau bị từ chối", () => {
  const errors = validate({ JWT_SECRET: strong("c"), QR_JWT_SECRET: strong("c") });
  assert.deepEqual(errors, ["JWT_SECRET và QR_JWT_SECRET phải khác nhau."]);
});

test("bật Stripe mà thiếu webhook secret bị từ chối", () => {
  assert.equal(validate({ ...valid, STRIPE_SECRET_KEY: "sk_test_x" }).length, 1);
  assert.deepEqual(validate({ ...valid, STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" }), []);
});

test("load() ném lỗi INVALID_CONFIG khi cấu hình sai, trả về object bất biến khi đúng", () => {
  assert.throws(() => load({}), (err) => err.code === "INVALID_CONFIG");
  const cfg = load(valid);
  assert.equal(cfg.jwtSecret, valid.JWT_SECRET);
  assert.equal(cfg.stripeSecretKey, null);
  assert.ok(Object.isFrozen(cfg));
});
