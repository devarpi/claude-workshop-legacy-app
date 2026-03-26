const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

router.get('/login', (req, res) => res.render('auth/login', { error: null }));
router.get('/register', (req, res) => res.render('auth/register', { error: null }));

// No rate limiting - intentional vulnerability (CWE-307)
router.post('/login', authController.loginPage);
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  const userModel = require('../models/user');
  try {
    await userModel.create({ username, email, password });
    res.redirect('/login');
  } catch (err) {
    res.render('auth/register', { error: err.message });
  }
});

router.get('/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect('/login');
});

module.exports = router;
