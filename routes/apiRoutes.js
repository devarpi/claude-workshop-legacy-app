const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const authController = require('../controllers/authController');
const orderController = require('../controllers/orderController');

// Auth endpoints (no auth required)
router.post('/auth/register', authController.register);
router.post('/auth/login', authController.login);

// User endpoints
router.get('/users/:userId', authenticate, orderController.getUser);

// Order endpoints
router.post('/orders', authenticate, orderController.placeOrder);
// IDOR: any authenticated user can fetch any userId's orders (CWE-639)
router.get('/orders/:userId', authenticate, orderController.getOrders);

module.exports = router;
