const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const path = require('path');

const authRoutes = require('./routes/authRoutes');
const orderRoutes = require('./routes/orderRoutes');
const apiRoutes = require('./routes/apiRoutes');

const app = express();

// No helmet - intentional vulnerability (missing security headers)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect('/login'));

app.use('/', authRoutes);
app.use('/orders', orderRoutes);
app.use('/api/v1', apiRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).render('error', { error: 'Page not found', stack: '' });
});

// Global error handler - leaks stack traces (CWE-209)
app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message, stack: err.stack });
});

module.exports = app;
