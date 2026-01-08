const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { auth, requireOrg } = require('../middlewares/auth.middleware');

// GET /api/transacciones
router.get('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { 
      cuenta_bancaria_id, contacto_id, tipo, buscar, sin_conciliar, conciliado,
      pagina = 1, limite = 20 
    } = req.query;

    let sql = `
      SELECT t.*, cb.nombre as nombre_cuenta, c.nombre as nombre_contacto
      FROM transacciones t
      LEFT JOIN cuentas_bancarias cb ON cb.id = t.cuenta_bancaria_id
      LEFT JOIN contactos c ON c.id = t.contacto_id
      WHERE t.organizacion_id = ?
    `;
    const params = [req.organizacion.id];

    if (cuenta_bancaria_id) {
      sql += ' AND t.cuenta_bancaria_id = ?';
      params.push(cuenta_bancaria_id);
    }
    if (contacto_id) {
      sql += ' AND t.contacto_id = ?';
      params.push(contacto_id);
    }
    if (tipo) {
      sql += ' AND t.tipo = ?';
      params.push(tipo);
    }
    if (sin_conciliar === '1') {
      sql += ' AND t.gasto_id IS NULL AND t.venta_id IS NULL';
    }
    if (conciliado === '1') {
      sql += ' AND (t.gasto_id IS NOT NULL OR t.venta_id IS NOT NULL)';
    }
    if (buscar) {
      sql += ' AND (t.descripcion LIKE ? OR t.referencia LIKE ?)';
      params.push(`%${buscar}%`, `%${buscar}%`);
    }

    // Count
    const countSql = sql.replace(/SELECT t\.\*.*FROM/s, 'SELECT COUNT(*) as total FROM');
    const [[{ total }]] = await db.query(countSql, params);

    const offset = (parseInt(pagina) - 1) * parseInt(limite);
    sql += ' ORDER BY t.fecha DESC, t.creado_en DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limite), offset);

    const [transacciones] = await db.query(sql, params);

    res.json({
      transacciones,
      paginacion: {
        total,
        pagina: parseInt(pagina),
        limite: parseInt(limite),
        paginas: Math.ceil(total / parseInt(limite))
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/transacciones/:id
router.get('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const [transacciones] = await db.query(
      `SELECT t.*, cb.nombre as nombre_cuenta
       FROM transacciones t
       LEFT JOIN cuentas_bancarias cb ON cb.id = t.cuenta_bancaria_id
       WHERE t.id = ? AND t.organizacion_id = ?`,
      [req.params.id, req.organizacion.id]
    );

    if (!transacciones.length) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    res.json(transacciones[0]);
  } catch (error) {
    next(error);
  }
});

// POST /api/transacciones
router.post('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { 
      cuenta_bancaria_id, tipo, monto, fecha, contacto_id,
      descripcion, referencia, comprobante_url,
      gasto_id, venta_id
    } = req.body;

    if (!cuenta_bancaria_id || !tipo || !monto || !fecha) {
      return res.status(400).json({ error: 'Cuenta, tipo, monto y fecha son requeridos' });
    }

    // Verificar cuenta
    const [cuentas] = await db.query(
      'SELECT id, saldo_actual FROM cuentas_bancarias WHERE id = ? AND organizacion_id = ?',
      [cuenta_bancaria_id, req.organizacion.id]
    );

    if (!cuentas.length) {
      return res.status(400).json({ error: 'Cuenta bancaria no válida' });
    }

    const transaccionId = uuidv4();
    const montoNum = parseFloat(monto);
    const saldoActual = parseFloat(cuentas[0].saldo_actual);
    const nuevoSaldo = tipo === 'ingreso' ? saldoActual + montoNum : saldoActual - montoNum;

    await db.query(
      `INSERT INTO transacciones 
       (id, organizacion_id, cuenta_bancaria_id, tipo, monto, fecha, contacto_id,
        descripcion, referencia, comprobante_url, gasto_id, venta_id, 
        saldo_despues, creado_por) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [transaccionId, req.organizacion.id, cuenta_bancaria_id, tipo, montoNum, fecha,
       contacto_id || null, descripcion || null, referencia || null, comprobante_url || null,
       gasto_id || null, venta_id || null, nuevoSaldo, req.usuario.id]
    );

    // Actualizar saldo cuenta
    await db.query('UPDATE cuentas_bancarias SET saldo_actual = ? WHERE id = ?', [nuevoSaldo, cuenta_bancaria_id]);

    // Si tiene gasto_id, actualizar el gasto con esta transaccion
    if (gasto_id) {
      await db.query('UPDATE gastos SET transaccion_id = ? WHERE id = ?', [transaccionId, gasto_id]);
    }

    res.status(201).json({ id: transaccionId, transaccion: { id: transaccionId, saldo_despues: nuevoSaldo } });
  } catch (error) {
    next(error);
  }
});

// PUT /api/transacciones/:id
router.put('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const { descripcion, referencia, comprobante_url, contacto_id, gasto_id, venta_id } = req.body;

    const [result] = await db.query(
      `UPDATE transacciones SET 
       descripcion = COALESCE(?, descripcion),
       referencia = ?,
       comprobante_url = ?,
       contacto_id = ?,
       gasto_id = ?,
       venta_id = ?
       WHERE id = ? AND organizacion_id = ?`,
      [descripcion, referencia || null, comprobante_url || null, 
       contacto_id || null, gasto_id || null, venta_id || null, 
       req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    res.json({ mensaje: 'Transacción actualizada' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/transacciones/:id
router.delete('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    // Obtener transacción
    const [trans] = await db.query(
      'SELECT * FROM transacciones WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (!trans.length) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    // Revertir saldo
    const ajuste = trans[0].tipo === 'ingreso' ? -parseFloat(trans[0].monto) : parseFloat(trans[0].monto);
    await db.query('UPDATE cuentas_bancarias SET saldo_actual = saldo_actual + ? WHERE id = ?', 
      [ajuste, trans[0].cuenta_bancaria_id]);

    // Limpiar referencia en gasto si existe
    if (trans[0].gasto_id) {
      await db.query('UPDATE gastos SET transaccion_id = NULL WHERE id = ?', [trans[0].gasto_id]);
    }

    // Eliminar
    await db.query('DELETE FROM transacciones WHERE id = ?', [req.params.id]);

    res.json({ mensaje: 'Transacción eliminada' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
