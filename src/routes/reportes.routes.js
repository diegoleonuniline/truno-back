const router = require('express').Router();
const db = require('../config/database');
const { auth, requireOrg, requireModule } = require('../middlewares/auth.middleware');

// GET /api/reportes/dashboard
router.get('/dashboard', auth, requireOrg, async (req, res, next) => {
  try {
    const { periodo = 'month' } = req.query;
    const orgId = req.organizacion.id;

    let filtroFecha;
    switch (periodo) {
      case 'week':
        filtroFecha = 'fecha >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
        break;
      case 'month':
        filtroFecha = 'fecha >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)';
        break;
      case 'quarter':
        filtroFecha = 'fecha >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)';
        break;
      case 'year':
        filtroFecha = 'fecha >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)';
        break;
      default:
        filtroFecha = 'fecha >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)';
    }

    const [
      [saldos],
      [ingresos],
      [egresos],
      [porCobrar],
      [porPagar],
      [transaccionesRecientes],
      [topCategorias]
    ] = await Promise.all([
      db.query(
        `SELECT SUM(saldo_actual) as saldo_total 
         FROM cuentas_bancarias WHERE organizacion_id = ? AND activo = 1`,
        [orgId]
      ),
      db.query(
        `SELECT COALESCE(SUM(monto), 0) as total, COUNT(*) as cantidad
         FROM transacciones_bancarias 
         WHERE organizacion_id = ? AND tipo = 'ingreso' AND ${filtroFecha}`,
        [orgId]
      ),
      db.query(
        `SELECT COALESCE(SUM(monto), 0) as total, COUNT(*) as cantidad
         FROM transacciones_bancarias 
         WHERE organizacion_id = ? AND tipo = 'egreso' AND ${filtroFecha}`,
        [orgId]
      ),
      db.query(
        `SELECT COALESCE(SUM(total - monto_pagado), 0) as total, COUNT(*) as cantidad
         FROM ventas 
         WHERE organizacion_id = ? AND estatus_pago IN ('pendiente', 'parcial')`,
        [orgId]
      ),
      db.query(
        `SELECT COALESCE(SUM(total - monto_pagado), 0) as total, COUNT(*) as cantidad
         FROM gastos 
         WHERE organizacion_id = ? AND estatus_pago IN ('pendiente', 'parcial')`,
        [orgId]
      ),
      db.query(
        `SELECT tb.id, tb.tipo, tb.monto, tb.fecha, tb.descripcion, cb.nombre as nombre_cuenta
         FROM transacciones_bancarias tb
         JOIN cuentas_bancarias cb ON cb.id = tb.cuenta_bancaria_id
         WHERE tb.organizacion_id = ?
         ORDER BY tb.fecha DESC, tb.creado_en DESC
         LIMIT 10`,
        [orgId]
      ),
      db.query(
        `SELECT categoria, tipo, SUM(monto) as total, COUNT(*) as cantidad
         FROM transacciones_bancarias
         WHERE organizacion_id = ? AND categoria IS NOT NULL AND ${filtroFecha}
         GROUP BY categoria, tipo
         ORDER BY total DESC
         LIMIT 10`,
        [orgId]
      )
    ]);

    const totalIngresos = parseFloat(ingresos[0]?.total) || 0;
    const totalEgresos = parseFloat(egresos[0]?.total) || 0;

    res.json({
      periodo,
      saldo: {
        total: parseFloat(saldos[0]?.saldo_total) || 0
      },
      flujo_efectivo: {
        ingresos: totalIngresos,
        egresos: totalEgresos,
        neto: totalIngresos - totalEgresos,
        ingresos_cantidad: ingresos[0]?.cantidad || 0,
        egresos_cantidad: egresos[0]?.cantidad || 0
      },
      pendientes: {
        por_cobrar: parseFloat(porCobrar[0]?.total) || 0,
        por_cobrar_cantidad: porCobrar[0]?.cantidad || 0,
        por_pagar: parseFloat(porPagar[0]?.total) || 0,
        por_pagar_cantidad: porPagar[0]?.cantidad || 0
      },
      transacciones_recientes: transaccionesRecientes,
      top_categorias: topCategorias
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/reportes/flujo-efectivo
router.get('/flujo-efectivo', auth, requireOrg, requireModule('reportes'), async (req, res, next) => {
  try {
    const { fecha_inicio, fecha_fin, agrupar_por = 'day' } = req.query;
    const orgId = req.organizacion.id;

    let formatoFecha;
    switch (agrupar_por) {
      case 'week':
        formatoFecha = '%Y-%u';
        break;
      case 'month':
        formatoFecha = '%Y-%m';
        break;
      default:
        formatoFecha = '%Y-%m-%d';
    }

    const fechaInicio = fecha_inicio || 'DATE_SUB(CURDATE(), INTERVAL 30 DAY)';
    const fechaFin = fecha_fin || 'CURDATE()';

    const [datos] = await db.query(
      `SELECT 
         DATE_FORMAT(fecha, '${formatoFecha}') as periodo,
         SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END) as ingresos,
         SUM(CASE WHEN tipo = 'egreso' THEN monto ELSE 0 END) as egresos
       FROM transacciones_bancarias
       WHERE organizacion_id = ?
       AND fecha >= ${fecha_inicio ? '?' : fechaInicio}
       AND fecha <= ${fecha_fin ? '?' : fechaFin}
       GROUP BY periodo
       ORDER BY periodo`,
      [orgId, ...(fecha_inicio ? [fecha_inicio] : []), ...(fecha_fin ? [fecha_fin] : [])]
    );

    let saldo = 0;
    const datosConSaldo = datos.map(row => {
      saldo += (parseFloat(row.ingresos) || 0) - (parseFloat(row.egresos) || 0);
      return {
        ...row,
        ingresos: parseFloat(row.ingresos) || 0,
        egresos: parseFloat(row.egresos) || 0,
        neto: (parseFloat(row.ingresos) || 0) - (parseFloat(row.egresos) || 0),
        saldo_acumulado: saldo
      };
    });

    res.json({
      agrupar_por,
      datos: datosConSaldo,
      totales: {
        ingresos: datos.reduce((sum, r) => sum + (parseFloat(r.ingresos) || 0), 0),
        egresos: datos.reduce((sum, r) => sum + (parseFloat(r.egresos) || 0), 0)
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/reportes/resumen-cuentas
router.get('/resumen-cuentas', auth, requireOrg, requireModule('bancos'), async (req, res, next) => {
  try {
    const orgId = req.organizacion.id;

    const [cuentas] = await db.query(
      `SELECT cb.id, cb.nombre, cb.nombre_banco, cb.moneda, cb.saldo_actual,
              (SELECT COUNT(*) FROM transacciones_bancarias WHERE cuenta_bancaria_id = cb.id) as total_transacciones,
              (SELECT SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END) 
               FROM transacciones_bancarias WHERE cuenta_bancaria_id = cb.id AND fecha >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) as ingresos_mes,
              (SELECT SUM(CASE WHEN tipo = 'egreso' THEN monto ELSE 0 END) 
               FROM transacciones_bancarias WHERE cuenta_bancaria_id = cb.id AND fecha >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) as egresos_mes
       FROM cuentas_bancarias cb
       WHERE cb.organizacion_id = ? AND cb.activo = 1
       ORDER BY cb.saldo_actual DESC`,
      [orgId]
    );

    res.json({
      cuentas: cuentas.map(c => ({
        ...c,
        saldo_actual: parseFloat(c.saldo_actual) || 0,
        ingresos_mes: parseFloat(c.ingresos_mes) || 0,
        egresos_mes: parseFloat(c.egresos_mes) || 0,
        neto_mes: (parseFloat(c.ingresos_mes) || 0) - (parseFloat(c.egresos_mes) || 0)
      })),
      saldo_total: cuentas.reduce((sum, c) => sum + (parseFloat(c.saldo_actual) || 0), 0)
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
