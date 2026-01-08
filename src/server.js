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
app.use('/api/organizaciones', require('./routes/organizaciones.routes'));
app.use('/api/cuentas-bancarias', require('./routes/cuentasBancarias.routes'));
app.use('/api/transacciones', require('./routes/transacciones.routes'));
app.use('/api/contactos', require('./routes/contactos.routes'));
app.use('/api/ventas', require('./routes/ventas.routes'));
app.use('/api/gastos', require('./routes/gastos.routes'));
app.use('/api/categorias', require('./routes/categorias.routes'));
app.use('/api/reportes', require('./routes/reportes.routes'));

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
