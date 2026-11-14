# Xử lý đồng thời & tính idempotent — Báo cáo kỹ thuật

> Phạm vi: backend (`backend/src`). Môi trường đo: Node.js 22, PostgreSQL 15 (Docker), Windows 11, cùng một máy.
> Tất cả số liệu dưới đây tái hiện được bằng các lệnh ở mục [Tái hiện](#5-tái-hiện).

## 1. Tóm tắt

Kiểm thử đồng thời phát hiện **6 lỗi** khiến hệ thống sai dữ liệu hoặc ngừng phục vụ khi nhiều người dùng thao tác cùng lúc.
Sau khi sửa, cả 4 kịch bản kiểm thử đồng thời đều đạt và luồng gọi món chịu tải tốt hơn rõ rệt:

| Chỉ số (k6, 50 người dùng đồng thời, 45 giây) | Trước | Sau |
|---|---|---|
| Thông lượng | 54,5 req/s | **1.084 req/s** (≈ ×20) |
| Tỉ lệ lỗi | 7,22 % (timeout) | **0 %** |
| Độ trễ p95 | 9.990 ms | **52 ms** |
| Độ trễ tối đa | 10.000 ms (timeout) | 139 ms |

## 2. Các lỗi đã phát hiện

| # | Lỗi | Vị trí | Hậu quả |
|---|---|---|---|
| 1 | **Deadlock do cạn connection pool**: hàm tạo đơn giữ 1 connection (`pool.connect()`) rồi lại xin thêm connection khác (`db.query`) từ cùng pool | `orders.controller.js#create` | Từ 10 request gọi món đồng thời (= kích thước pool), cả 10 cùng chờ nhau → **API gọi món treo vĩnh viễn** (pool không có timeout); `/health` vẫn báo "ok" |
| 2 | **Race condition tạo đơn trùng**: tìm "đơn đang mở của bàn" rồi mới tạo đơn, không khoá | `orders.controller.js#create` | Khách cùng bàn bấm "Gọi món" cùng lúc → **mỗi người một đơn** cho cùng một bàn |
| 3 | **Webhook Stripe không idempotent** | `payment.controller.js#handleStripeWebhook` | Stripe gửi lại sự kiện (at-least-once) → **cộng điểm thưởng nhiều lần** |
| 4 | **Thanh toán tiền mặt / VietQR không idempotent** | `processPayment`, `confirmVietQR` | Bấm "thanh toán" 2 lần → cộng điểm 2 lần |
| 5 | **Tiêu lố điểm thưởng**: đọc số dư rồi mới trừ (check-then-act) | `usepoints.controller.js` | 10 request dùng 100 điểm cùng lúc → **cả 10 thành công, điểm còn −900** |
| 6 | **Webhook Stripe luôn sai chữ ký**: `express.json()` toàn cục parse body trước khi tới `express.raw()` của route webhook | `index.js` | Khi cấu hình `STRIPE_WEBHOOK_SECRET`, **mọi webhook hợp lệ đều bị từ chối (400)** → thanh toán thẻ không bao giờ được tự động xác nhận |

## 3. Cách khắc phục

### 3.1 Một giao dịch = một connection (lỗi 1)
- Thêm `db.withTransaction(work)`: lấy **một** connection, `BEGIN` → `work(client)` → `COMMIT`/`ROLLBACK`, luôn trả connection.
  Mọi truy vấn trong giao dịch dùng `client` được truyền vào.
- Pool có `connectionTimeoutMillis` (mặc định 5 s, cấu hình qua `PG_CONNECTION_TIMEOUT_MS`): nếu thật sự cạn connection
  thì request báo lỗi nhanh thay vì treo vô hạn. Kích thước pool cấu hình qua `PG_POOL_MAX`.
- Kiểm chứng: chạy bộ test với `PG_POOL_MAX=3` và 200 request đồng thời → không deadlock, 4/4 kịch bản đạt.

### 3.2 Khoá theo bàn khi gọi món (lỗi 2)
```sql
SELECT id, table_number FROM tables WHERE id = $1 FOR UPDATE;  -- khoá dòng của BÀN
SELECT ... FROM orders WHERE table_id = $1 AND status NOT IN ('paid','cancelled');
```
Request gọi món cho **cùng một bàn** được xếp hàng tuần tự: request sau chỉ tìm đơn mở sau khi request trước đã `COMMIT`
(ở mức READ COMMITTED, mỗi câu lệnh lấy snapshot mới sau khi có khoá) nên thấy đơn vừa tạo và gộp vào.
Các bàn khác nhau không chặn nhau.

**Vì sao không dùng cách khác?**
| Phương án | Lý do không chọn |
|---|---|
| `SERIALIZABLE` | Đúng nhưng phải tự viết vòng lặp retry khi bị huỷ do xung đột; tốn hơn cho luồng nóng nhất |
| Chỉ dùng unique index | Request thua sẽ lỗi (500/409) thay vì được gộp vào đơn → trải nghiệm xấu |
| Khoá dòng đơn hàng | Không có dòng nào để khoá khi bàn **chưa có** đơn — chính là trường hợp gây trùng |

### 3.3 Thanh toán idempotent (lỗi 3, 4)
Ba luồng thanh toán dùng chung `services/payment.service.js#markOrderPaid`:
1. `SELECT ... FROM orders WHERE id = $1 FOR UPDATE` — khoá đơn.
2. Đã `paid` → trả `alreadyPaid: true`, **không** cộng điểm, không phát lại sự kiện socket.
3. Đã `cancelled` → 409.
4. Ngược lại: chuyển `paid`, cộng điểm, giải phóng bàn — trong cùng giao dịch.

Webhook: lỗi bất ngờ (vd. mất kết nối DB) trả **500 để Stripe gửi lại** — an toàn vì đã idempotent;
lỗi nghiệp vụ vĩnh viễn (đơn không tồn tại/đã huỷ) trả 200 để Stripe không gửi lại vô ích.
Chỉ xử lý khi `session.payment_status === 'paid'`.

### 3.4 Trừ điểm nguyên tử (lỗi 5)
```sql
UPDATE users SET total_points = total_points - $1
 WHERE id = $2 AND total_points >= $1;   -- rowCount = 0 → "không đủ điểm"
```
Điều kiện được kiểm tra **tại thời điểm ghi**, không dựa trên giá trị đã đọc trước đó.

### 3.5 Raw body cho webhook (lỗi 6)
`express.json()` bỏ qua đúng đường dẫn `/api/payment/stripe/webhook`; route này tự dùng `express.raw()`
nên `stripe.webhooks.constructEvent` nhận đúng chuỗi byte gốc để kiểm chữ ký.

### 3.6 Phòng thủ nhiều lớp ở tầng CSDL
Khoá trong code là lớp thứ nhất; CSDL giữ bất biến kể cả khi sau này có code mới quên khoá:
```sql
CREATE UNIQUE INDEX uq_orders_one_open_per_table
  ON orders(table_id) WHERE status NOT IN ('paid', 'cancelled');   -- ≤ 1 đơn mở / bàn
ALTER TABLE users ADD CONSTRAINT users_total_points_check CHECK (total_points >= 0);
```
Database đang chạy: áp dụng `backend/migrations/001_concurrency_safety.sql` (idempotent, có truy vấn kiểm tra đơn trùng cũ).

## 4. Kết quả đo

### 4.1 Kiểm thử đồng thời (`backend/tests/concurrency/run.js`)
Bộ test bắn request **thực sự đồng thời** vào API rồi kiểm tra bất biến **trực tiếp trong PostgreSQL**.
Mỗi lượt chạy trên server khởi động mới.

| Kịch bản | Tải | Trước | Sau |
|---|---|---|---|
| A. Gọi món đồng thời | 10 bàn × 20 request | **198/200 request timeout** (deadlock) | 200/200 thành công, 10 đơn cho 10 bàn, p95 583 ms |
| A. Gọi món đồng thời (dưới ngưỡng deadlock) | 3 bàn × 3 request | **9 đơn cho 3 bàn** (6 đơn trùng) | 3 đơn cho 3 bàn |
| B. Webhook Stripe gửi lại | 10 lần, có chữ ký | Có chữ ký: **10/10 bị từ chối (400)**. Không chữ ký: **cộng điểm 10 lần** (500 thay vì 50) | 10/10 nhận, cộng điểm **1 lần** (50) |
| C. Bấm thanh toán nhiều lần | 10 lần | Cộng điểm **10 lần** | Cộng điểm **1 lần** |
| D. Dùng 100 điểm | 10 lần | 10/10 chấp nhận, điểm còn **−900**, giảm giá 1.000đ | 1 chấp nhận, 9 từ chối, điểm còn 0, giảm giá 100đ |
| A–D với `PG_POOL_MAX=3` | như trên | — | 4/4 đạt |

### 4.2 Load test (`backend/loadtest/order-load.k6.js`)
k6 0.54, 50 người dùng ảo (tăng dần 10 s → giữ 30 s → giảm 5 s), gọi món liên tục vào 20 bàn.

| Chỉ số | Trước | Sau |
|---|---|---|
| Tổng request | 2.935 | 48.778 |
| Thông lượng | 54,5 req/s | 1.084 req/s |
| Tỉ lệ lỗi | 7,22 % | 0 % |
| p50 / p90 / p95 | 11 / 29 / 9.990 ms | 41 / 49 / 52 ms |
| Ngưỡng (lỗi < 1 %, p95 < 500 ms) | ✗ | ✓ |
| Bàn có > 1 đơn mở | 0 | 0 |

Bản cũ ngừng xử lý từ giây thứ ~4 (≈ 19 người dùng ảo) — khớp với lỗi deadlock khi số request đồng thời vượt kích thước pool.

## 5. Tái hiện

```bash
# 1. CSDL tạm (không đụng dữ liệu thật)
docker run -d --name sr-bench-db -e POSTGRES_PASSWORD=bench -e POSTGRES_DB=smart_restaurant -p 55432:5432 postgres:15-alpine

cd backend
export DATABASE_URL=postgres://postgres:bench@localhost:55432/smart_restaurant
export JWT_SECRET=test-jwt QR_JWT_SECRET=test-qr STRIPE_SECRET_KEY=sk_test_dummy STRIPE_WEBHOOK_SECRET=whsec_test
npm run migrate && npm run seed
PORT=4000 node src/index.js &

# 2. Kiểm thử đồng thời (A–D)
npm run test:concurrency

# 3. Load test
node loadtest/prepare-tables.js 20          # in ra TABLE_IDS=... và ITEM_ID=...
docker run --rm -i -e BASE_URL=http://host.docker.internal:4000 \
  -e TABLE_IDS=<...> -e ITEM_ID=<...> grafana/k6:0.54.0 run - < loadtest/order-load.k6.js
node loadtest/prepare-tables.js --report    # kiểm tra bàn có đơn trùng
node loadtest/prepare-tables.js --cleanup
```

Biến điều chỉnh bộ test: `TABLES`, `BURST`, `REPLAYS`, `SCENARIOS=A,B,C,D`, `REQUEST_TIMEOUT_MS`, `KEEP_DATA=1`.

## 6. Giới hạn & việc tiếp theo
- Khoá theo bàn tuần tự hoá việc gọi món **trong cùng một bàn** — chấp nhận được vì một bàn chỉ có vài khách.
- Webhook vẫn chấp nhận sự kiện không ký khi **thiếu** `STRIPE_WEBHOOK_SECRET` (chế độ thử nghiệm) — sẽ chuyển sang
  bắt buộc cùng với việc bỏ các secret mặc định (`JWT_SECRET || "secret"`).
- Các thao tác chuyển trạng thái của phục vụ/bếp (nhận đơn, báo xong món) vẫn kiểm tra rồi mới cập nhật trong hai câu lệnh
  riêng; hậu quả nếu chạy đua chỉ là gửi trùng thông báo, không sai tiền/điểm — sẽ chuyển sang `UPDATE ... WHERE status = ...`.
- Bộ test đồng thời là kiểm thử tích hợp cần API + CSDL đang chạy; có thể đưa vào CI bằng service container PostgreSQL.
