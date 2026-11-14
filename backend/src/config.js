/**
 * Cấu hình bảo mật — đọc và KIỂM TRA biến môi trường một lần khi khởi động (fail-fast).
 *
 * Trước đây mỗi nơi tự dùng `process.env.JWT_SECRET || "secret"`: thiếu biến môi trường thì server vẫn
 * chạy với secret ai cũng đoán được → kẻ tấn công tự ký token admin. Nay thiếu/yếu secret là KHÔNG khởi động.
 */
require("dotenv").config();

const MIN_SECRET_LENGTH = 32;
/** Entropy tối thiểu (bit) theo ước lượng Shannon — 128 bit là mức của khoá HMAC an toàn. */
const MIN_SECRET_ENTROPY_BITS = 128;

/**
 * Ước lượng entropy của chuỗi theo tần suất ký tự (Shannon): H × độ dài.
 * Chỉ là ước lượng CẬN TRÊN — chặn được chuỗi lặp ("aaaa…", "abcabc…") hay ít ký tự khác nhau,
 * nhưng không phát hiện được cụm từ dễ đoán; vì vậy thông báo lỗi luôn hướng dẫn sinh secret ngẫu nhiên.
 */
function estimateEntropyBits(value) {
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) || 0) + 1);
  let bitsPerChar = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bitsPerChar -= p * Math.log2(p);
  }
  return bitsPerChar * value.length;
}

// Giá trị mặc định cũ trong code và các giá trị mẫu trong file .env*.example — không bao giờ được dùng thật.
const KNOWN_WEAK_SECRETS = new Set([
  "secret",
  "qr_secret_key",
  "your-super-secret-jwt-key",
  "your-super-secret-jwt-key-change-this",
  "your-qr-secret-key",
  "smart-restaurant-jwt-secret-key-2024",
  "smart-restaurant-jwt-secret-2024-production", // từng ghi công khai trong DEPLOYMENT_GUIDE.md
  "smart-restaurant-qr-secret-2024",
  "change-me",
]);

const GENERATE_HINT =
  'Tạo secret ngẫu nhiên: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"';

/** Trả về danh sách lỗi cấu hình (rỗng = hợp lệ). Tách riêng để kiểm thử được. */
function validate(env) {
  const errors = [];

  const checkSecret = (name) => {
    const value = env[name];
    if (!value) errors.push(`${name} chưa được đặt.`);
    else if (KNOWN_WEAK_SECRETS.has(value)) errors.push(`${name} đang dùng giá trị mẫu/mặc định công khai.`);
    else if (value.length < MIN_SECRET_LENGTH) errors.push(`${name} phải dài ít nhất ${MIN_SECRET_LENGTH} ký tự.`);
    // /^(.+?)\1+$/: chuỗi chỉ là một mẫu lặp lại ("abcdabcd…") — ước lượng Shannon theo ký tự không thấy được điều này.
    else if (estimateEntropyBits(value) < MIN_SECRET_ENTROPY_BITS || /^(.+?)\1+$/s.test(value)) {
      errors.push(`${name} quá dễ đoán (lặp lại hoặc ít ký tự khác nhau) — cần secret ngẫu nhiên.`);
    }
  };
  checkSecret("JWT_SECRET");
  checkSecret("QR_JWT_SECRET");

  // Dùng chung secret thì token đăng nhập có thể bị dùng làm token QR và ngược lại.
  if (env.JWT_SECRET && env.JWT_SECRET === env.QR_JWT_SECRET) {
    errors.push("JWT_SECRET và QR_JWT_SECRET phải khác nhau.");
  }

  // Đã bật Stripe thì webhook bắt buộc có secret để xác thực chữ ký — nếu không, ai cũng giả được "đã thanh toán".
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) {
    errors.push("STRIPE_WEBHOOK_SECRET là bắt buộc khi đã đặt STRIPE_SECRET_KEY.");
  }

  return errors;
}

function load(env = process.env) {
  const errors = validate(env);
  if (errors.length > 0) {
    const err = new Error(
      `Cấu hình bảo mật không hợp lệ:\n  - ${errors.join("\n  - ")}\n${GENERATE_HINT}`
    );
    err.code = "INVALID_CONFIG";
    throw err;
  }
  return Object.freeze({
    jwtSecret: env.JWT_SECRET,
    qrJwtSecret: env.QR_JWT_SECRET,
    stripeSecretKey: env.STRIPE_SECRET_KEY || null,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
  });
}

module.exports = { ...load(), validate, load, estimateEntropyBits, MIN_SECRET_LENGTH, MIN_SECRET_ENTROPY_BITS };
