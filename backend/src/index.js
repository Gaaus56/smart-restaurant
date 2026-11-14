const express = require("express");
const cors = require("cors");
const http = require("http");
const helmet = require("helmet");
require("dotenv").config();

const { initSocket } = require("./socket");
const {
  apiLimiter,
  authLimiter,
  orderLimiter,
} = require("./middleware/rateLimiter");

const authRouter = require("./routes/auth"); 
const tablesRouter = require("./routes/tables");
const qrRouter = require("./routes/qr");
const publicRouter = require("./routes/public");
const errorHandler = require("./middleware/errorHandler");
const {
  requireAuth,
  requireRole,
  requireCustomer,
  optionalCustomer,
} = require("./middleware/authMiddleware");
const categoriesRouter = require("./routes/categories");
const itemsRouter = require("./routes/items");
const path = require("path");
const photosRouter = require("./routes/photos");
const modifiersRouter = require("./routes/modifiers");
const ordersRouter = require("./routes/orders");
const waiterRouter = require("./routes/waiter");
const kitchenRouter = require("./routes/kitchen");
const paymentRouter = require("./routes/payment");
const reportsRouter = require("./routes/reports");
const reviewsRouter = require("./routes/reviews"); 
const usersRouter = require("./routes/users");

// New routes
const customerRouter = require("./routes/customer");

const app = express();
app.set('trust proxy', 1); // Trust first proxy - fix for X-Forwarded-For header
const server = http.createServer(app);

initSocket(server);

// Security middleware
// app.use(helmet({
//   contentSecurityPolicy: false, // Disable for development, enable in production
//   crossOriginEmbedderPolicy: false
// }));

app.use(
  cors({
    origin: true, // Reflect request origin
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
      "Origin",
    ],
  })
);
app.options("*", cors());

// Webhook Stripe cần RAW body để xác thực chữ ký → không parse JSON cho route này
// (route tự dùng express.raw()). Nếu express.json() chạy trước, mọi webhook hợp lệ đều bị từ chối.
const STRIPE_WEBHOOK_PATH = "/api/payment/stripe/webhook";
const jsonParser = express.json();
app.use((req, res, next) => (req.path === STRIPE_WEBHOOK_PATH ? next() : jsonParser(req, res, next)));

// Apply general rate limiter to all API routes
app.use("/api/", apiLimiter);

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Giúp truy cập ảnh qua link
app.use("/uploads", express.static(path.join(__dirname, "../public/uploads")));

// --- ROUTES ---
const adminProfileRoutes = require("./routes/admin-profile");

app.use("/api/auth", authLimiter, authRouter);
app.use("/api/customer", customerRouter);
app.use("/api/orders", orderLimiter, ordersRouter);
app.use("/api/payment", paymentRouter);

// Role Routes
app.use("/api/waiter", requireAuth, requireRole(["waiter", "admin"]), waiterRouter);
app.use("/api/kitchen", requireAuth, requireRole(["kitchen", "admin"]), kitchenRouter);

// Admin Routes
app.use("/api/admin/tables", requireAuth, requireRole("admin"), tablesRouter);
app.use("/api/admin/tables", requireAuth, requireRole("admin"), qrRouter);
app.use("/api/admin/menu/categories", requireAuth, requireRole(["admin"]), categoriesRouter);
app.use("/api/admin/menu/items", requireAuth, requireRole(["admin"]), photosRouter);
app.use("/api/admin/menu/items", requireAuth, requireRole(["admin"]), itemsRouter);
app.use("/api/admin/menu", requireAuth, requireRole(["admin"]), modifiersRouter);
app.use("/api/admin/reports", requireAuth, requireRole("admin"), reportsRouter);
app.use("/api/admin", adminProfileRoutes); // Admin profile routes
app.use("/api/users", requireAuth, requireRole("admin"), usersRouter);

// Public Routes
app.use("/api/qr", qrRouter); // QR verify (public)
app.use("/api/menu", optionalCustomer, publicRouter);
app.use("/api/menu", optionalCustomer, reviewsRouter); // Reviews (GET public, POST requires customer)
app.use("/api/orders", orderLimiter, optionalCustomer, ordersRouter); // Attach customer if logged in
app.use("/api/payment", optionalCustomer, paymentRouter);

// Customer Profile Routes (requires customer login)
app.use("/api/customer", customerRouter);

app.use(errorHandler);

app.get("/test-cors", (req, res) => {
  res.send(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body{font-family:sans-serif;padding:20px}button{padding:10px 20px;font-size:16px;margin-bottom:10px}pre{background:#f4f4f4;padding:10px;overflow:auto}</style>
      </head>
      <body>
        <h1>Test Kết Nối (CORS)</h1>
        <p>IP Backend: 192.168.1.3:4000</p>
        <button onclick="test()">👉 Bấm vào đây để Test API</button>
        <div id="status">Chưa chạy</div>
        <pre id="result"></pre>
        <script>
          async function test() {
            const status = document.getElementById('status');
            const result = document.getElementById('result');
            status.innerText = 'Đang gọi API...';
            result.innerText = '';
            
            try {
              // Gọi chính API menu
              const res = await fetch('http://192.168.1.3:4000/api/menu/categories');
              if (!res.ok) throw new Error('Status: ' + res.status);
              
              const data = await res.json();
              status.innerText = '✅ Thành công!';
              status.style.color = 'green';
              result.innerText = JSON.stringify(data, null, 2);
            } catch (err) {
              status.innerText = '❌ Thất bại';
              status.style.color = 'red';
              result.innerText = 'Lỗi chi tiết: ' + err.message;
            }
          }
        </script>
      </body>
    </html>
  `);
});

const port = process.env.PORT || 4000;
const host = "0.0.0.0"; // Cho phép truy cập từ điện thoại qua IP

server.listen(port, host, () => {
  console.log(`🚀 Backend & Socket running on http://${host}:${port}`);
  console.log(`📱 Truy cập từ điện thoại: http://192.168.1.3:${port}`);
});
