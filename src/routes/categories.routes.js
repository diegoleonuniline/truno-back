const router = require('express').Router();
const db = require('../config/database');
const { auth, requireOrg } = require('../middlewares/auth.middleware');

// GET /api/categories - Obtener todas las categorías usadas
router.get('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { type } = req.query; // 'ingreso' o 'egreso'

    const results = { ingresos: [], egresos: [] };

    // Categorías de ingresos (transacciones)
    if (!type || type === 'ingreso') {
      const [ingresos] = await db.query(
        `SELECT category, COUNT(*) as count, SUM(amount) as total
         FROM bank_transactions 
         WHERE organization_id = ? AND type = 'ingreso' AND category IS NOT NULL
         GROUP BY category
         ORDER BY count DESC`,
        [req.organization.id]
      );
      results.ingresos = ingresos;
    }

    // Categorías de egresos (transacciones + gastos)
    if (!type || type === 'egreso') {
      const [egresos] = await db.query(
        `SELECT category, COUNT(*) as count, SUM(amount) as total
         FROM (
           SELECT category, amount FROM bank_transactions 
           WHERE organization_id = ? AND type = 'egreso' AND category IS NOT NULL
           UNION ALL
           SELECT category, total as amount FROM expenses 
           WHERE organization_id = ? AND category IS NOT NULL
         ) combined
         GROUP BY category
         ORDER BY count DESC`,
        [req.organization.id, req.organization.id]
      );
      results.egresos = egresos;
    }

    res.json(results);
  } catch (error) {
    next(error);
  }
});

// GET /api/categories/suggestions - Sugerencias de categorías predefinidas
router.get('/suggestions', auth, async (req, res) => {
  const suggestions = {
    ingresos: [
      'Ventas',
      'Servicios',
      'Comisiones',
      'Intereses',
      'Rentas',
      'Otros ingresos'
    ],
    egresos: [
      'Nómina',
      'Alquiler de oficina',
      'Suministros',
      'Software & Servicios',
      'Marketing',
      'Transporte',
      'Comida',
      'Servicios profesionales',
      'Impuestos',
      'Seguros',
      'Mantenimiento',
      'Otros gastos'
    ]
  };

  res.json(suggestions);
});

module.exports = router;
