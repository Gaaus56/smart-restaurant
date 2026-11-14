/**
 * Auth Controller
 * Handles all authentication-related business logic
 */

const db = require("../db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const config = require("../config");
const crypto = require("crypto");
const sendEmail = require("../utils/sendEmail");
const { OAuth2Client } = require("google-auth-library");

// Google OAuth Client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Helper: Validate Password Strength
function validatePassword(password) {
  const minLength = 8;
  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasNumber = /\d/.test(password);
  const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);
  
  if (password.length < minLength) {
    return { valid: false, message: `Mật khẩu phải có ít nhất ${minLength} ký tự` };
  }
  if (!hasUpperCase) {
    return { valid: false, message: "Mật khẩu phải có ít nhất 1 chữ hoa" };
  }
  if (!hasLowerCase) {
    return { valid: false, message: "Mật khẩu phải có ít nhất 1 chữ thường" };
  }
  if (!hasNumber) {
    return { valid: false, message: "Mật khẩu phải có ít nhất 1 chữ số" };
  }
  if (!hasSpecialChar) {
    return { valid: false, message: "Mật khẩu phải có ít nhất 1 ký tự đặc biệt (!@#$%^&*...)" };
  }
  
  return { valid: true };
}

// Helper: Validate Full Name
function validateFullName(name) {
  if (!name || name.trim().length === 0) {
    return { valid: false, message: "Họ và tên là bắt buộc" };
  }
  if (name.trim().length < 2) {
    return { valid: false, message: "Họ và tên phải có ít nhất 2 ký tự" };
  }
  if (!/^[a-zA-ZÀ-ỹ\s]+$/.test(name)) {
    return { valid: false, message: "Họ và tên chỉ được chứa chữ cái và khoảng trắng" };
  }
  return { valid: true };
}

/**
 * POST /api/auth/register
 * Register staff (Admin only)
 */
exports.registerStaff = async (req, res, next) => {
  try {
    const { email, password, role, full_name, phone } = req.body;

    // Validate Input
    if (!email || !password || !role) {
      return res.status(400).json({ message: "Email, password, and role are required" });
    }

    // Chặn đăng ký Admin qua API này
    if (role === "admin") {
      return res.status(403).json({
        message: "Registration for admin role is restricted.",
      });
    }

    // Validate Role
    const validRoles = ["staff", "waiter", "kitchen"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({
        message: "Invalid role. Allowed roles: staff, waiter, kitchen",
      });
    }

    // Check Email exists
    const userCheck = await db.query("SELECT 1 FROM users WHERE email = $1", [email]);
    if (userCheck.rowCount > 0) {
      return res.status(400).json({ message: "Email already exists" });
    }

    // Hash Password
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert DB (Staff mặc định active, không cần verify email)
    const newUser = await db.query(
      `INSERT INTO users (email, password_hash, full_name, phone, role, status, auth_provider) 
       VALUES ($1, $2, $3, $4, $5, 'active', 'local') 
       RETURNING id, email, full_name, role, status, created_at`,
      [email, passwordHash, full_name, phone, role]
    );

    res.status(201).json({
      message: "Staff user created successfully",
      user: newUser.rows[0],
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/login
 * Login (Universal: Admin, Staff, Guest)
 */
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Find user
    const result = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0];

    // Check password
    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Check status
    if (user.status === "inactive") {
      return res.status(403).json({ message: "Please verify your email first!" });
    }
    if (user.status === "banned") {
      return res.status(403).json({ message: "Account is banned" });
    }

    // Generate Token
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      config.jwtSecret,
      { expiresIn: "1d" }
    );

    res.json({
      message: "Login successful",
      token: token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        full_name: user.full_name,
        avatar: user.avatar_url,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/guest/register
 * Guest self-registration
 */
exports.guestRegister = async (req, res, next) => {
  try {
    const { email, password, full_name, phone } = req.body;

    // Validation đầu vào
    if (!email || !password) {
      return res.status(400).json({ message: "Email và mật khẩu là bắt buộc" });
    }

    // Validate tên
    const nameValidation = validateFullName(full_name);
    if (!nameValidation.valid) {
      return res.status(400).json({ message: nameValidation.message });
    }

    // Validate độ mạnh mật khẩu
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ message: passwordValidation.message });
    }

    // Check email tồn tại
    const check = await db.query("SELECT 1 FROM users WHERE email = $1", [email]);
    if (check.rowCount > 0) {
      return res.status(400).json({ message: "Email đã được sử dụng" });
    }

    const hash = await bcrypt.hash(password, 10);
    const verifyToken = crypto.randomBytes(32).toString("hex");

    // Insert user với status 'inactive' và role 'guest'
    const newUser = await db.query(
      `INSERT INTO users (email, password_hash, full_name, phone, role, status, auth_provider, verification_token) 
       VALUES ($1, $2, $3, $4, 'guest', 'inactive', 'local', $5)
       RETURNING id`,
      [email, hash, full_name.trim(), phone, verifyToken]
    );

    const newUserId = newUser.rows[0].id;

    // Gửi email xác thực
    try {
      const verifyUrl = `${process.env.CLIENT_BASE_URL}/guest/verify-email?token=${verifyToken}`;
      const message = `Chào mừng bạn đến với Smart Restaurant!\n\nVui lòng click vào link dưới đây để xác thực tài khoản:\n${verifyUrl}\n\nLink này có hiệu lực trong 24 giờ.\n\nNếu bạn không đăng ký tài khoản này, vui lòng bỏ qua email này.`;
      
      await sendEmail(email, "Xác thực tài khoản - Smart Restaurant", message);

      res.status(201).json({ 
        message: "Đăng ký thành công! Vui lòng kiểm tra email để xác thực tài khoản.",
        email: email
      });
    } catch (emailError) {
      console.error("❌ Lỗi gửi email:", emailError.message);
    
      // Rollback - xóa user vừa tạo
      await db.query("DELETE FROM users WHERE id = $1", [newUserId]);

      return res.status(500).json({ 
        message: "Không thể gửi email xác thực. Vui lòng kiểm tra cấu hình email hoặc thử lại sau.",
        error: process.env.NODE_ENV === 'development' ? emailError.message : undefined
      });
    }
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/auth/verify-email
 * Verify email with token
 */
exports.verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.query;

    console.log("🔍 Verify email request - Token:", token?.substring(0, 10) + "...");

    if (!token) {
      return res.status(400).json({ message: "Token xác thực không hợp lệ" });
    }

    // Tìm user với token và chưa verify
    const result = await db.query(
      "SELECT id, email, full_name, status FROM users WHERE verification_token = $1",
      [token]
    );

    const user = result.rows[0];
    console.log("📧 User found:", user ? `${user.email} (status: ${user.status})` : "Not found");

    if (!user) {
      return res.status(400).json({ 
        message: "Token không hợp lệ hoặc đã hết hạn" 
      });
    }

    if (user.status === 'active') {
      return res.status(200).json({ 
        message: "Tài khoản đã được xác thực trước đó",
        alreadyVerified: true
      });
    }

    // Cập nhật status thành active và xóa token
    await db.query(
      "UPDATE users SET status = 'active', verification_token = NULL WHERE id = $1",
      [user.id]
    );

    res.status(200).json({ 
      message: "Xác thực tài khoản thành công! Bạn có thể đăng nhập ngay.",
      user: {
        email: user.email,
        full_name: user.full_name
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/google
 * Google OAuth login
 */
exports.googleAuth = async (req, res, next) => {
  try {
    const { idToken } = req.body; 
    if (!idToken) return res.status(400).json({ message: "Google ID token is required" });

    // 1. Verify Token với Google
    const ticket = await googleClient.verifyIdToken({
      idToken: idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { email, name, picture, sub: googleId } = payload;

    // 2. Check user trong bảng USERS
    let { rows } = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    let user = rows[0];

    if (!user) {
      // 3a. Chưa có -> Tạo mới (Role guest, Status active)
      const newUser = await db.query(
        `INSERT INTO users (email, full_name, avatar_url, role, status, auth_provider, google_id)
         VALUES ($1, $2, $3, 'guest', 'active', 'google', $4)
         RETURNING *`,
        [email, name, picture, googleId]
      );
      user = newUser.rows[0];
    } else {
      // 3b. Đã có -> Update google_id nếu chưa link
      await db.query(
          `UPDATE users 
           SET auth_provider = 'google', 
               google_id = $1, 
               avatar_url = $2, 
               full_name = $3,
               status = CASE WHEN status = 'inactive' THEN 'active' ELSE status END
           WHERE id = $4`, 
          [googleId, picture, name, user.id]
      );
      
      const updatedUser = await db.query("SELECT * FROM users WHERE id = $1", [user.id]);
      user = updatedUser.rows[0];
    }

    if (user.status === 'banned') {
        return res.status(403).json({ message: "Account is banned" });
    }

    // 4. Cấp Token JWT
    const accessToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      config.jwtSecret,
      { expiresIn: "1d" }
    );

    res.json({
      message: "Google Login successful",
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        full_name: user.full_name,
        avatar: user.avatar_url, 
      },
    });
  } catch (err) {
    console.error("Google Auth Error:", err);
    res.status(401).json({ message: "Google auth failed: " + err.message });
  }
};

/**
 * POST /api/auth/forgot-password
 * Request password reset
 */
exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ message: "Vui lòng nhập email" });
    }

    const { rows } = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = rows[0];

    // Không tiết lộ thông tin user có tồn tại hay không (bảo mật)
    if (!user) {
      return res.json({ 
        message: "Nếu email tồn tại, link reset mật khẩu đã được gửi.",
        success: true
      });
    }
    
    // Nếu user dùng Google OAuth
    if (user.auth_provider === 'google') {
      return res.status(400).json({ 
        message: "Tài khoản này đăng nhập bằng Google. Vui lòng đăng nhập bằng Google." 
      });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
    const expireTime = new Date(Date.now() + 3600000); // 1 giờ

    await db.query(
      "UPDATE users SET reset_password_token = $1, reset_password_expires = $2 WHERE id = $3",
      [resetTokenHash, expireTime, user.id]
    );

    try {
      const resetUrl = `${process.env.CLIENT_BASE_URL}/guest/reset-password?token=${resetToken}`;
      const message = `Bạn đã yêu cầu reset mật khẩu cho tài khoản Smart Restaurant.\n\nVui lòng click vào link dưới đây để tạo mật khẩu mới:\n${resetUrl}\n\nLink này có hiệu lực trong 1 giờ.\n\nNếu bạn không yêu cầu reset mật khẩu, vui lòng bỏ qua email này.`;

      await sendEmail(user.email, "Reset mật khẩu - Smart Restaurant", message);

      if (process.env.NODE_ENV !== "production") {
        console.log(`[DEV] Reset Token cho ${email}: ${resetToken}`);
      }

      res.json({ 
        message: "Link reset mật khẩu đã được gửi đến email của bạn.",
        success: true
      });
    } catch (emailError) {
      console.error("❌ Lỗi gửi email reset:", emailError.message);
      return res.status(500).json({ 
        message: "Không thể gửi email. Vui lòng thử lại sau.",
        error: process.env.NODE_ENV === 'development' ? emailError.message : undefined
      });
    }
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/reset-password
 * Reset password with token
 */
exports.resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ message: "Thiếu thông tin token hoặc mật khẩu mới" });
    }

    // Validate độ mạnh mật khẩu mới
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) {
      return res.status(400).json({ message: passwordValidation.message });
    }

    const resetTokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const { rows } = await db.query(
      `SELECT * FROM users 
       WHERE reset_password_token = $1 
       AND reset_password_expires > NOW()`,
      [resetTokenHash]
    );

    const user = rows[0];
    if (!user) {
      return res.status(400).json({ 
        message: "Link reset mật khẩu không hợp lệ hoặc đã hết hạn" 
      });
    }

    const newPassHash = await bcrypt.hash(newPassword, 10);

    await db.query(
      `UPDATE users 
       SET password_hash = $1, reset_password_token = NULL, reset_password_expires = NULL 
       WHERE id = $2`,
      [newPassHash, user.id]
    );

    res.json({ 
      message: "Reset mật khẩu thành công! Bạn có thể đăng nhập với mật khẩu mới.",
      success: true
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/auth/verify
 * Verify JWT token
 */
exports.verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ message: "No token provided" });

    const decoded = jwt.verify(token, config.jwtSecret);

    const result = await db.query(
      "SELECT id, email, full_name, role, status, avatar_url FROM users WHERE id = $1",
      [decoded.userId]
    );
    const user = result.rows[0];

    if (!user) return res.status(401).json({ message: "User not found" });
    if (user.status !== "active") return res.status(403).json({ message: "Account is inactive" });

    res.json({
      valid: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        full_name: user.full_name,
        avatar: user.avatar_url,
      },
    });
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Invalid or expired token" });
    }
    next(err);
  }
};

/**
 * PUT /api/auth/change-password
 * Change password (logged in user)
 */
exports.changePassword = async (req, res, next) => {
  try {
    const userId = req.user.userId; // Lấy từ middleware requireAuth
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Current and new password are required" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: "New password must be at least 6 characters" });
    }

    const { rows } = await db.query("SELECT password_hash, auth_provider FROM users WHERE id = $1", [userId]);
    const user = rows[0];

    if (!user) return res.status(404).json({ message: "User not found" });

    // Nếu user login bằng Google thì không có password để check
    if (user.auth_provider === 'google') {
        return res.status(400).json({ message: "Google account cannot change password here." });
    }

    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) return res.status(401).json({ message: "Incorrect current password" });

    const newHash = await bcrypt.hash(newPassword, 10);
    await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [newHash, userId]);

    res.json({ message: "Password updated successfully" });
  } catch (err) {
    next(err);
  }
};