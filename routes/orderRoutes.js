const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const orderController = require('../controllers/orderController');

router.get('/', authenticate, orderController.getOrdersPage);
router.get('/new', authenticate, (req, res) => res.render('orders/new', { error: null }));
router.post('/', authenticate, orderController.placeOrderPage);

module.exports = router;
