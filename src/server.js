require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const app = express();

// Middlewares de seguridad
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Demasiadas solicitudes, intenta más tarde' }
});
app.use('/api/', limiter);

// Rutas
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/organizations', require('./routes/organizations.routes'));
app.use('/api/bank-accounts', require('./routes/bankAccounts.routes'));
app.use('/api/transactions', require('./routes/transactions.routes'));
app.use('/api/contacts', require('./routes/contacts.routes'));
app.use('/api/sales', require('./routes/sales.routes'));
app.use('/api/expenses', require('./routes/expenses.routes'));
app.use('/api/payments', require('./routes/payments.routes'));
app.use('/api/categories', require('./routes/categories.routes'));
app.use('/api/reports', require('./routes/reports.routes'));
app.use('/api/upload', require('./routes/upload.routes'));
app.use('/api/sat', require('./routes/sat.routes'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// Error handler global
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Error interno del servidor',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 TRUNO Backend corriendo en puerto ${PORT}`);
});

module.exports = app;
