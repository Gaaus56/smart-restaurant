require("./helpers");
const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeClient } = require("./helpers");
const db = require("../../src/db");

function withFakePool(client, fn) {
  const original = db.pool.connect;
  db.pool.connect = async () => client;
  return fn().finally(() => {
    db.pool.connect = original;
  });
}

test("thành công: BEGIN → công việc → COMMIT, trả connection về pool", async () => {
  const c = new FakeClient();
  const result = await withFakePool(c, () =>
    db.withTransaction(async (client) => {
      await client.query("SELECT 1");
      return "done";
    })
  );
  assert.equal(result, "done");
  assert.deepEqual(c.queries.map((q) => q.sql), ["BEGIN", "SELECT 1", "COMMIT"]);
  assert.ok(c.released);
});

test("lỗi: ROLLBACK, ném lại lỗi gốc, vẫn trả connection về pool", async () => {
  const c = new FakeClient();
  await assert.rejects(
    withFakePool(c, () =>
      db.withTransaction(async () => {
        throw db.httpError(409, "conflict");
      })
    ),
    (err) => err.status === 409 && err.message === "conflict"
  );
  assert.deepEqual(c.queries.map((q) => q.sql), ["BEGIN", "ROLLBACK"]);
  assert.ok(c.released);
});

test("toàn bộ giao dịch chạy trên đúng MỘT connection (không xin thêm từ pool → không deadlock khi pool cạn)", async () => {
  let connects = 0;
  const c = new FakeClient();
  const original = db.pool.connect;
  db.pool.connect = async () => {
    connects += 1;
    return c;
  };
  try {
    await db.withTransaction(async (client) => {
      await client.query("SELECT 1");
      await client.query("SELECT 2");
    });
  } finally {
    db.pool.connect = original;
  }
  assert.equal(connects, 1);
});
