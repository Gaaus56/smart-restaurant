const jwt = require('jsonwebtoken');
const config = require('../config');

const requireAuth = (req, res, next) => {
  // Check token from header first, then query string (for downloads)
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];
  
  // If no token in header, check query string
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ message: 'Authentication required (Missing Token)' });
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    req.user = decoded; 
    next();
  } catch (err) {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
};

const requireRole = (role) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'User not authenticated' });
    }
    
    const allowedRoles = Array.isArray(role) ? role : [role];

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        message: `Access denied. Required role(s): ${allowedRoles.join(', ')}` 
      });
    }
    next();
  };
};

// Middleware cho Customer (yêu cầu đăng nhập)
const requireCustomer = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Customer authentication required' });
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    
    // Support both token types:
    // 1. customerAuth token: { customerId, type: 'customer' }
    // 2. auth.js token: { userId, email, role: 'guest' }
    if (decoded.type === 'customer') {
      req.customer = { 
        ...decoded, 
        userId: decoded.customerId // Map customerId -> userId for consistency
      };
    } else if (decoded.userId && decoded.role === 'guest') {
      req.customer = {
        userId: decoded.userId,
        customerId: decoded.userId, // Also set customerId for backward compat
        email: decoded.email,
        role: decoded.role
      };
    } else {
      return res.status(403).json({ message: 'Customer access only' });
    }
    
    next();
  } catch (err) {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
};

// Middleware optional - không bắt buộc login nhưng nếu có token thì attach customer
const optionalCustomer = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    try {
      const decoded = jwt.verify(token, config.jwtSecret);
      
      console.log('🔍 optionalCustomer - decoded token:', decoded);
      
      // Hỗ trợ 2 loại token:
      // 1. customerAuth token: { customerId, type: 'customer' }
      // 2. auth.js token: { userId, email, role }
      if (decoded.type === 'customer') {
        // Token từ customerAuth.js (bảng customers cũ)
        req.customer = { 
          ...decoded, 
          userId: decoded.customerId // Map customerId -> userId để nhất quán
        };
      } else if (decoded.userId) {
        // Token từ auth.js (bảng users mới) - chấp nhận tất cả role
        req.customer = {
          userId: decoded.userId,
          email: decoded.email,
          role: decoded.role
        };
      }
      
      console.log('✅ req.customer set to:', req.customer);
    } catch (err) {
      // Token không hợp lệ - bỏ qua, tiếp tục như guest
      console.log('❌ Token verification failed:', err.message);
    }
  }
  next();
};

module.exports = { requireAuth, requireRole, requireCustomer, optionalCustomer };