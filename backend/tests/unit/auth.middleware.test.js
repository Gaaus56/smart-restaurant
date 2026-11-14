require("./helpers");
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { mockRes } = require("./helpers");
const config = require("../../src/config");
const { requireAuth, requireRole, requireCustomer } = require("../../src/middleware/authMiddleware");

function run(middleware, headers = {}, extra = {}) {
  const req = { headers, query: {}, ...extra };
  const res = mockRes();
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  return { req, res, nextCalled };
}

const bearer = (payload, secret = config.jwtSecret) => ({ authorization: `Bearer ${jwt.sign(payload, secret)}` });

test("token hợp lệ → cho qua, gắn req.user", () => {
  const { req, nextCalled } = run(requireAuth, bearer({ userId: "u1", role: "admin" }));
  assert.ok(nextCalled);
  assert.equal(req.user.role, "admin");
});

test("token ký bằng secret mặc định cũ 'secret' bị TỪ CHỐI (lỗ hổng đã đóng)", () => {
  const { res, nextCalled } = run(requireAuth, bearer({ userId: "u1", role: "admin" }, "secret"));
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test("token QR (ký bằng QR_JWT_SECRET) không dùng được làm token đăng nhập", () => {
  const { nextCalled } = run(requireAuth, bearer({ userId: "u1", role: "admin" }, config.qrJwtSecret));
  assert.equal(nextCalled, false);
});

test("không có token → 401", () => {
  const { res } = run(requireAuth);
  assert.equal(res.statusCode, 401);
});

test("requireRole: đúng vai trò → qua; sai vai trò → 403", () => {
  const ok = run(requireRole(["waiter", "admin"]), {}, { user: { role: "waiter" } });
  assert.ok(ok.nextCalled);
  const denied = run(requireRole("admin"), {}, { user: { role: "waiter" } });
  assert.equal(denied.res.statusCode, 403);
});

test("requireCustomer: token khách (role guest) → qua; token nhân viên → 403", () => {
  const guest = run(requireCustomer, bearer({ userId: "g1", role: "guest" }));
  assert.ok(guest.nextCalled);
  assert.equal(guest.req.customer.userId, "g1");
  const staff = run(requireCustomer, bearer({ userId: "s1", role: "waiter" }));
  assert.equal(staff.res.statusCode, 403);
});
