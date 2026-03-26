const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/db');

const authenticate = (req, res, next) => {
  const token = req.cookies.token || req.headers['authorization'];

  if (!token) {
    if (req.path.startsWith('/api')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    return res.redirect('/login');
  }

  try {
    // algorithms option not pinned - intentional vulnerability (JWT alg confusion) (CWE-327)
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (req.path.startsWith('/api')) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    return res.redirect('/login');
  }
};

module.exports = { authenticate };
