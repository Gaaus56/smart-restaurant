/**
 * Payment Service — nghiệp vụ "đánh dấu đơn đã thanh toán", dùng chung cho mọi phương thức
 * (tiền mặt, VietQR, webhook Stripe).
 *
 * Yêu cầu IDEMPOTENT: cùng một đơn có thể bị yêu cầu thanh toán nhiều lần
 * (nhân viên bấm 2 lần, khách bấm lại, Stripe gửi lại webhook…) nhưng chỉ được
 * chuyển trạng thái và cộng điểm thưởng ĐÚNG MỘT LẦN.
 */

const { httpError } = require("../db");

/** 1 điểm thưởng cho mỗi 10.000đ. */
const VND_PER_POINT = 10000;

/**
 * Phải được gọi bên trong giao dịch (db.withTransaction).
 * @returns {{ order, alreadyPaid: boolean, pointsAwarded: number, tableNumber }}
 */
async function markOrderPaid(client, orderId) {
  // THỨ TỰ KHOÁ: luôn khoá BÀN trước rồi mới khoá ĐƠN — giống luồng gọi món (orders.create).
  // Nếu hai luồng khoá ngược thứ tự (gọi món: bàn → đơn, thanh toán: đơn → bàn), khách gọi thêm món
  // đúng lúc đơn đang được thanh toán sẽ gây deadlock và PostgreSQL huỷ một trong hai giao dịch.
  // table_id của một đơn không bao giờ đổi nên đọc trước (không khoá) là an toàn.
  const { rows: found } = await client.query("SELECT table_id FROM orders WHERE id = $1", [orderId]);
  if (found.length === 0) throw httpError(404, "Order not found");

  let tableNumber = null;
  if (found[0].table_id) {
    const { rows: tables } = await client.query(
      "SELECT table_number FROM tables WHERE id = $1 FOR UPDATE",
      [found[0].table_id]
    );
    tableNumber = tables[0]?.table_number ?? null;
  }

  // Khoá dòng đơn hàng: các yêu cầu thanh toán đồng thời cho cùng một đơn chạy tuần tự.
  // Yêu cầu đến sau phải chờ yêu cầu trước COMMIT rồi mới đọc lại trạng thái → thấy 'paid'.
  const { rows } = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
  const current = rows[0];

  if (current.status === "paid") {
    return { order: current, alreadyPaid: true, pointsAwarded: 0, tableNumber };
  }
  if (current.status === "cancelled") {
    throw httpError(409, "Order has been cancelled");
  }

  const { rows: updated } = await client.query(
    "UPDATE orders SET status = 'paid', paid_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *",
    [orderId]
  );
  const order = updated[0];

  let pointsAwarded = 0;
  if (order.user_id) {
    pointsAwarded = Math.floor((parseFloat(order.total_amount) || 0) / VND_PER_POINT);
    if (pointsAwarded > 0) {
      await client.query(
        "UPDATE users SET total_points = COALESCE(total_points, 0) + $1 WHERE id = $2",
        [pointsAwarded, order.user_id]
      );
    }
  }

  // Free up the table
  if (order.table_id) {
    await client.query("UPDATE tables SET status = 'active', updated_at = NOW() WHERE id = $1", [
      order.table_id,
    ]);
  }

  return { order, alreadyPaid: false, pointsAwarded, tableNumber };
}

module.exports = { markOrderPaid, VND_PER_POINT };
