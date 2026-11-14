const db = require("../db");

/**
 * PATCH /api/orders/:id/use-points
 * Apply customer points to reduce order total (1 point = 1đ)
 * Body: { points: number }
 * Auth: customer
 *
 * Đồng thời: trước đây đọc số điểm rồi mới trừ (check-then-act) nên nhiều request song song
 * cùng "thấy đủ điểm" và cùng trừ → điểm âm. Nay khoá đơn hàng và trừ điểm bằng MỘT câu UPDATE
 * có điều kiện `total_points >= $1`, CSDL đảm bảo chỉ request còn đủ điểm mới trừ được.
 */
exports.usePoints = async (req, res, next) => {
  const { id } = req.params;
  const points = Number(req.body.points);

  if (!req.customer || !req.customer.userId) {
    return res.status(401).json({ message: "Customer login required" });
  }
  if (!Number.isInteger(points) || points <= 0) {
    return res.status(400).json({ message: "Số điểm không hợp lệ" });
  }

  try {
    await db.withTransaction(async (client) => {
      const orderRes = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [id]);
      if (orderRes.rowCount === 0) throw db.httpError(404, "Order not found");

      const order = orderRes.rows[0];
      if (order.status === "paid" || order.status === "cancelled") {
        throw db.httpError(400, "Order đã thanh toán hoặc đã hủy");
      }
      if (order.user_id !== req.customer.userId) {
        throw db.httpError(403, "Bạn không thể dùng điểm cho đơn này");
      }

      // Trừ điểm nguyên tử: chỉ thành công nếu số dư hiện tại (tại thời điểm ghi) còn đủ.
      const spent = await client.query(
        "UPDATE users SET total_points = total_points - $1 WHERE id = $2 AND total_points >= $1",
        [points, order.user_id]
      );
      if (spent.rowCount === 0) throw db.httpError(400, "Bạn không đủ điểm");

      // Cộng vào discount_amount (nếu đã có giảm giá khác thì cộng dồn)
      await client.query(
        "UPDATE orders SET discount_amount = COALESCE(discount_amount,0) + $1, updated_at = NOW() WHERE id = $2",
        [points, id]
      );
    });

    res.json({ message: `Đã dùng ${points} điểm để giảm ${points}đ cho đơn hàng`, pointsUsed: points });
  } catch (err) {
    next(err);
  }
};
