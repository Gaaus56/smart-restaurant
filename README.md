# 🍽️ Smart Restaurant Management System

Dự án xây dựng hệ thống quản lý nhà hàng thông minh, áp dụng quy trình Scrum/Agile.

## 🎯 Mục tiêu dự án

Xây dựng giải pháp toàn diện bao gồm:

1.  **Guest Ordering**: Khách hàng quét QR gọi món.
2.  **Kitchen Display System (KDS)**: Màn hình bếp thời gian thực.
3.  **Admin Dashboard**: Quản lý menu, bàn và doanh thu.

## 👥 Nhóm phát triển

| Thành viên | MSSV | GitHub |
|------------|------|--------|
| Nguyễn Lê Thế Vinh (Leader) | 23120190 | [Zinthw](https://github.com/Zinthw) |
| Trần Thanh An | 23120017 | [Gaaus56](https://github.com/Gaaus56) |
| Nguyễn Thị Ánh Ngọc | 23120061 | [angquoc](https://github.com/angquoc) |

## 🛠️ Công nghệ dự kiến

- **Backend**: Node.js, Express, PostgreSQL
- **Frontend**: Next.js (hoặc React Vite), TailwindCSS
- **Real-time**: Socket.IO

## 🔒 Xử lý đồng thời & kiểm thử tải

Backend đã được kiểm thử với nhiều người dùng thao tác cùng lúc. Kết quả đo được (k6, 50 người dùng đồng thời):
thông lượng gọi món **54 → 1.084 req/s**, tỉ lệ lỗi **7,2 % → 0 %**, p95 **9,99 s → 52 ms**.
Các khắc phục chính: chống deadlock do cạn connection pool, khoá theo bàn chống tạo đơn trùng,
thanh toán/webhook Stripe idempotent, trừ điểm thưởng nguyên tử, ràng buộc bất biến ở tầng CSDL.

Chi tiết lỗi, giải pháp, số liệu trước/sau và cách tái hiện: [docs/CONCURRENCY.md](docs/CONCURRENCY.md).
