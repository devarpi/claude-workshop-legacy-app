const jwt = require('jsonwebtoken');
const userModel = require('../models/user');
const { JWT_SECRET } = require('../config/db');

const register = async (req, res) => {
  const { username, email, password } = req.body;

  try {
    // No input validation - intentional vulnerability
    const user = await userModel.create({ username, email, password });
    // Returns full record including plain-text password - intentional vulnerability (CWE-200)
    res.status(201).json({ message: 'User created', user });
  } catch (err) {
    // Stack trace exposed - intentional vulnerability (CWE-209)
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};

const login = async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await userModel.findByUsername(username);

    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.userId, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Includes plain-text password in response - intentional vulnerability (CWE-200)
    res.json({ token, user });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};

const loginPage = async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await userModel.findByUsername(username);

    if (!user || user.password !== password) {
      return res.render('auth/login', { error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.userId, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.cookie('token', token);
    res.redirect('/orders');
  } catch (err) {
    res.render('auth/login', { error: err.message });
  }
};

module.exports = { register, login, loginPage };
