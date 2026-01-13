require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
onst plataformasRoutes = require('./routes/plataformas.routes');

// Validar variables de entorno críticas al iniciar
// Relacionado con: .env (configuración del servidor)
if (!process.env.JWT_SECRET) {
  console.error('❌ ERROR: JWT_SECRET no está definido en las variables de entorno');
  console.error('   Por favor, agrega JWT_SECRET a tu archivo .env');
  process.exit(1);
}

if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_PASSWORD || !process.env.DB_NAME) {
  console.error('❌ ERROR: Variables de base de datos faltantes en .env');
  process.exit(1);
}

console.log('✅ Variables de entorno cargadas correctamente');
console.log('   JWT_SECRET:', process.env.JWT_SECRET ? '✓ Configurado' : '✗ Faltante');
console.log('   DB_HOST:', process.env.DB_HOST || '✗ Faltante');

const app = express();

// IMPORTANTE: Para Heroku/proxies
app.set('trust proxy', 1);

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
  max: 500,
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
app.use('/api/impuestos', require('./routes/impuestos.routes'));
app.use('/api/reportes', require('./routes/reportes.routes'));
app.use('/api/plataformas', plataformasRoutes);

// Catálogos
app.use('/api/subcategorias', require('./routes/subcategorias.routes'));
app.use('/api/metodos-pago', require('./routes/metodosPago.routes'));
app.use('/api/monedas', require('./routes/monedas.routes'));

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
