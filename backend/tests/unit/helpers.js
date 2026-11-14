/**
 * Tiện ích cho unit test: client PostgreSQL giả (ghi lại mọi câu SQL), response giả,
 * và biến môi trường hợp lệ (config.js fail-fast nếu thiếu secret).
 * Phải được require TRƯỚC mọi module trong src/.
 */
process.env.JWT_SECRET = "unit-test-jwt-secret-0123456789abcdef0123";
process.env.QR_JWT_SECRET = "unit-test-qr-secret-0123456789abcdef01234";
process.env.STRIPE_SECRET_KEY = "sk_test_unit";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit_test_secret";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://unit:test@127.0.0.1:1/unit";

const crypto = require("crypto");

/**
 * Client giả: `handlers` là danh sách [regex, (params, sql) => kết quả].
 * Câu SQL đầu tiên khớp regex được trả về; không khớp → { rows: [], rowCount: 0 }.
 */
class FakeClient {
  constructor(handlers = []) {
    this.handlers = handlers;
    this.queries = [];
    this.released = false;
  }

  async query(text, params = []) {
    const sql = text.replace(/\s+/g, " ").trim();
    this.queries.push({ sql, params });
    for (const [pattern, handler] of this.handlers) {
      if (pattern.test(sql)) {
        const result = (await handler(params, sql)) || {};
        const rows = result.rows || [];
        return { rows, rowCount: result.rowCount ?? rows.length };
      }
    }
    return { rows: [], rowCount: 0 };
  }

  release() {
    this.released = true;
  }

  /** Vị trí (index) của câu SQL đầu tiên khớp pattern, -1 nếu không có. */
  indexOf(pattern) {
    return this.queries.findIndex((q) => pattern.test(q.sql));
  }

  count(pattern) {
    return this.queries.filter((q) => pattern.test(q.sql)).length;
  }
}

/** Thay db.withTransaction bằng bản chạy `work` trên client giả. Trả về hàm khôi phục. */
function useFakeTransaction(db, client) {
  const original = db.withTransaction;
  db.withTransaction = async (work) => work(client);
  return () => {
    db.withTransaction = original;
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

/** Gọi handler Express; lỗi chuyển qua next() được trả về để kiểm tra. */
async function invoke(handler, req, res = mockRes()) {
  let forwarded = null;
  await handler(req, res, (err) => {
    forwarded = err || null;
  });
  return { res, err: forwarded };
}

/** Ký payload giống Stripe (header Stripe-Signature, HMAC-SHA256). */
function stripeSignature(payload, secret = process.env.STRIPE_WEBHOOK_SECRET) {
  const ts = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac("sha256", secret).update(`${ts}.${payload}`).digest("hex");
  return `t=${ts},v1=${v1}`;
}

module.exports = { FakeClient, useFakeTransaction, mockRes, invoke, stripeSignature };
