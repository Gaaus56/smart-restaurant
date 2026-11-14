-- ============================================================
-- 001_concurrency_safety.sql
-- Ràng buộc bất biến ở tầng CSDL — lớp phòng thủ thứ hai bên cạnh khoá dòng (FOR UPDATE)
-- trong code ứng dụng. Áp dụng cho database ĐANG CHẠY (migrate.js đã có sẵn khi tạo mới).
--
-- Chạy: psql "$DATABASE_URL" -f migrations/001_concurrency_safety.sql
-- ============================================================

BEGIN;

-- 1. Kiểm tra dữ liệu cũ: bàn đang có nhiều hơn 1 đơn mở (do lỗi race condition trước đây).
--    Nếu câu truy vấn này trả về dòng nào, cần gộp/huỷ các đơn trùng TRƯỚC khi tạo index.
SELECT table_id, COUNT(*) AS open_orders
  FROM orders
 WHERE status NOT IN ('paid', 'cancelled')
 GROUP BY table_id
HAVING COUNT(*) > 1;

-- 2. Mỗi bàn chỉ có tối đa 1 đơn đang mở.
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_one_open_per_table
  ON orders(table_id) WHERE status NOT IN ('paid', 'cancelled');

-- 3. Điểm thưởng không bao giờ âm (sửa số dư âm cũ về 0 trước khi thêm ràng buộc).
UPDATE users SET total_points = 0 WHERE total_points < 0;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_total_points_check;
ALTER TABLE users ADD CONSTRAINT users_total_points_check CHECK (total_points >= 0);

COMMIT;
