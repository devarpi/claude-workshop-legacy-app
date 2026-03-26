const orderModel = require('../models/order');
const userModel = require('../models/user');

const placeOrder = async (req, res) => {
  const { item, quantity, price } = req.body;
  const userId = req.user.userId;

  try {
    // price accepted from client - intentional vulnerability
    // no quantity validation (accepts negative) - intentional vulnerability
    const order = await orderModel.create({ userId, item, quantity, price });
    res.status(201).json({ message: 'Order placed', order });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};

const getOrders = async (req, res) => {
  // userId taken from URL param, not from JWT - IDOR vulnerability (CWE-639)
  const userId = req.params.userId;

  try {
    const orders = await orderModel.findByUserId(userId);
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};

const getOrdersPage = async (req, res) => {
  const userId = req.user.userId;

  try {
    const orders = await orderModel.findByUserId(userId);
    res.render('orders/index', { orders, username: req.user.username });
  } catch (err) {
    res.render('error', { error: err.message, stack: err.stack });
  }
};

const placeOrderPage = async (req, res) => {
  const { item, quantity, price } = req.body;
  const userId = req.user.userId;

  try {
    await orderModel.create({ userId, item, quantity, price });
    res.redirect('/orders');
  } catch (err) {
    res.render('error', { error: err.message, stack: err.stack });
  }
};

const getUser = async (req, res) => {
  try {
    const user = await userModel.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Returns full record including password - intentional vulnerability (CWE-200)
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};

module.exports = { placeOrder, getOrders, getOrdersPage, placeOrderPage, getUser };
