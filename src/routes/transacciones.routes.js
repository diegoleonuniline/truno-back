const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth, requireOrg, requireModule } = require('../middlewares/auth.middleware');

// GET /api/transacciones
router.get('/', auth, requireOrg, requireModule('bancos'), async (req, res, next) => {
  try {
    const { 
      cuenta_id, tipo, categoria, fecha_inicio, fecha_fin, 
      buscar, pagina = 1, limite = 50 
    } = req.query;

    let sql = `
      SELECT tb.*, cb.nombre as nombre_cuenta, cb.moneda,
             c.nombre as nombre_contacto,
             v.numero_venta,
             g.numero_gasto
      FROM transacciones_bancarias tb
      JOIN cuentas_bancarias cb ON cb.id = tb.cuenta_bancaria_id
      LEFT JOIN contactos c ON c.id = (
        SELECT contacto_id FROM ventas WHERE id = tb.venta_vinculada_id
        UNION
        SELECT contacto_id FROM gastos WHERE id = tb.gasto_vinculado_id
        LIMIT 1
      )
      LEFT JOIN ventas v ON v.id = tb.venta_vinculada_id
      LEFT JOIN gastos g ON g.id = tb.gasto_vinculado_id
      WHERE tb.organizacion_id = ?
    `;
    const params = [req.organizacion.id];

    if (cuenta_id) {
      sql += ' AND tb.cuenta_bancaria_id = ?';
      params.push(cuenta_id);
    }
    if (tipo) {
      sql += ' AND tb.tipo = ?';
      params.push(tipo);
    }
    if (categoria) {
      sql += ' AND tb.categoria = ?';
      params.push(categoria);
    }
    if (fecha_inicio) {
      sql += ' AND tb.fecha >= ?';
      params.push(fecha_inicio);
    }
    if (fecha_fin) {
      sql += ' AND tb.fecha <= ?';
      params.push(fecha_fin);
    }
    if (buscar) {
      sql += ' AND (tb.descripcion LIKE ? OR tb.referencia LIKE ?)';
      params.push(`%${buscar}%`, `%${buscar}%`);
    }

    const countSql = sql.replace(/SELECT .* FROM/, 'SELECT COUNT(*) as total FROM');
    const [[{ total }]] = await db.query(countSql, params);

    const offset = (parseInt(pagina) - 1) * parseInt(limite);
    sql += ' ORDER BY tb.fecha DESC, tb.creado_en DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limite), offset);

    const [transacciones] = await db.query(sql, params);

    const [balanceResult] = await db.query(`
      SELECT 
        SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END) as total_ingresos,
        SUM(CASE WHEN tipo = 'egreso' THEN monto ELSE 0 END) as total_egresos
      FROM transacciones_bancarias
      WHERE organizacion_id = ?
      ${cuenta_id ? 'AND cuenta_bancaria_id = ?' : ''}
      ${fecha_inicio ? 'AND fecha >= ?' : ''}
      ${fecha_fin ? 'AND fecha <= ?' : ''}
    `, [req.organizacion.id, ...(cuenta_id ? [cuenta_id] : []), 
        ...(fecha_inicio ? [fecha_inicio] : []), ...(fecha_fin ? [fecha_fin] : [])]);

    res.json({
      transacciones,
      paginacion: {
        total,
        pagina: parseInt(pagina),
        limite: parseInt(limite),
        paginas: Math.ceil(total / parseInt(limite))
      },
      resumen: {
        ingresos: parseFloat(balanceResult[0]?.total_ingresos) || 0,
        egresos: parseFloat(balanceResult[0]?.total_egresos) || 0,
        balance: (parseFloat(balanceResult[0]?.total_ingresos) || 0) - 
                 (parseFloat(balanceResult[0]?.total_egresos) || 0)
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/transacciones/:id
router.get('/:id', auth, requireOrg, requireModule('bancos'), async (req, res, next) => {
  try {
    const [transacciones] = await db.query(
      `SELECT tb.*, cb.nombre as nombre_cuenta, cb.moneda
       FROM transacciones_bancarias tb
       JOIN cuentas_bancarias cb ON cb.id = tb.cuenta_bancaria_id
       WHERE tb.id = ? AND tb.organizacion_id = ?`,
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
router.post('/', auth, requireOrg, requireModule('bancos'), [
  body('cuenta_bancaria_id').isUUID(),
  body('tipo').isIn(['ingreso', 'egreso']),
  body('monto').isDecimal({ decimal_digits: '0,2' }),
  body('fecha').isDate(),
  body('descripcion').trim().notEmpty()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { 
      cuenta_bancaria_id, tipo, monto, fecha, descripcion, 
      metodo_pago, referencia, categoria, notas 
    } = req.body;

    const [cuentas] = await db.query(
      'SELECT id, saldo_actual FROM cuentas_bancarias WHERE id = ? AND organizacion_id = ? AND activo = 1',
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
      `INSERT INTO transacciones_bancarias 
       (id, organizacion_id, cuenta_bancaria_id, tipo, monto, fecha, descripcion, metodo_pago, referencia, categoria, notas, saldo_despues, creado_por) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [transaccionId, req.organizacion.id, cuenta_bancaria_id, tipo, montoNum, fecha, 
       descripcion, metodo_pago || null, referencia || null, categoria || null, 
       notas || null, nuevoSaldo, req.usuario.id]
    );

    await db.query(
      'UPDATE cuentas_bancarias SET saldo_actual = ? WHERE id = ?',
      [nuevoSaldo, cuenta_bancaria_id]
    );

    res.status(201).json({ 
      id: transaccionId,
      saldo_despues: nuevoSaldo
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/transacciones/transferencia
router.post('/transferencia', auth, requireOrg, requireModule('bancos'), [
  body('cuenta_origen_id').isUUID(),
  body('cuenta_destino_id').isUUID(),
  body('monto').isDecimal({ decimal_digits: '0,2' }),
  body('fecha').isDate()
], async (req, res, next) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { cuenta_origen_id, cuenta_destino_id, monto, fecha, descripcion, referencia } = req.body;

    if (cuenta_origen_id === cuenta_destino_id) {
      return res.status(400).json({ error: 'Las cuentas deben ser diferentes' });
    }

    const [cuentas] = await connection.query(
      'SELECT id, nombre, saldo_actual FROM cuentas_bancarias WHERE id IN (?, ?) AND organizacion_id = ? AND activo = 1',
      [cuenta_origen_id, cuenta_destino_id, req.organizacion.id]
    );

    if (cuentas.length !== 2) {
      return res.status(400).json({ error: 'Cuentas no válidas' });
    }

    const idParTransferencia = uuidv4();
    const egresoId = uuidv4();
    const ingresoId = uuidv4();
    const desc = descripcion || 'Transferencia entre cuentas';
    const montoNum = parseFloat(monto);

    const cuentaOrigen = cuentas.find(c => c.id === cuenta_origen_id);
    const cuentaDestino = cuentas.find(c => c.id === cuenta_destino_id);

    const nuevoSaldoOrigen = parseFloat(cuentaOrigen.saldo_actual) - montoNum;
    const nuevoSaldoDestino = parseFloat(cuentaDestino.saldo_actual) + montoNum;

    // Egreso
    await connection.query(
      `INSERT INTO transacciones_bancarias 
       (id, organizacion_id, cuenta_bancaria_id, tipo, monto, fecha, descripcion, metodo_pago, referencia, es_transferencia_interna, id_par_transferencia, saldo_despues, creado_por) 
       VALUES (?, ?, ?, 'egreso', ?, ?, ?, 'transferencia', ?, 1, ?, ?, ?)`,
      [egresoId, req.organizacion.id, cuenta_origen_id, montoNum, fecha, desc, referencia || null, idParTransferencia, nuevoSaldoOrigen, req.usuario.id]
    );

    // Ingreso
    await connection.query(
      `INSERT INTO transacciones_bancarias 
       (id, organizacion_id, cuenta_bancaria_id, tipo, monto, fecha, descripcion, metodo_pago, referencia, es_transferencia_interna, id_par_transferencia, saldo_despues, creado_por) 
       VALUES (?, ?, ?, 'ingreso', ?, ?, ?, 'transferencia', ?, 1, ?, ?, ?)`,
      [ingresoId, req.organizacion.id, cuenta_destino_id, montoNum, fecha, desc, referencia || null, idParTransferencia, nuevoSaldoDestino, req.usuario.id]
    );

    // Actualizar saldos
    await connection.query('UPDATE cuentas_bancarias SET saldo_actual = ? WHERE id = ?', [nuevoSaldoOrigen, cuenta_origen_id]);
    await connection.query('UPDATE cuentas_bancarias SET saldo_actual = ? WHERE id = ?', [nuevoSaldoDestino, cuenta_destino_id]);

    await connection.commit();

    res.status(201).json({ 
      id_par_transferencia: idParTransferencia,
      egreso_id: egresoId,
      ingreso_id: ingresoId
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// PUT /api/transacciones/:id
router.put('/:id', auth, requireOrg, requireModule('bancos'), async (req, res, next) => {
  try {
    const { descripcion, categoria, referencia, notas, metodo_pago } = req.body;

    const [trans] = await db.query(
      'SELECT venta_vinculada_id, gasto_vinculado_id, es_transferencia_interna FROM transacciones_bancarias WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (!trans.length) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    if (trans[0].venta_vinculada_id || trans[0].gasto_vinculado_id) {
      return res.status(400).json({ error: 'No se puede editar transacciones vinculadas a ventas/gastos' });
    }

    await db.query(
      `UPDATE transacciones_bancarias SET 
       descripcion = COALESCE(?, descripcion),
       categoria = COALESCE(?, categoria),
       referencia = COALESCE(?, referencia),
       notas = COALESCE(?, notas),
       metodo_pago = COALESCE(?, metodo_pago)
       WHERE id = ? AND organizacion_id = ?`,
      [descripcion, categoria, referencia, notas, metodo_pago, req.params.id, req.organizacion.id]
    );

    res.json({ mensaje: 'Transacción actualizada' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/transacciones/:id
router.delete('/:id', auth, requireOrg, requireModule('bancos'), async (req, res, next) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [trans] = await connection.query(
      `SELECT tb.*, cb.saldo_actual 
       FROM transacciones_bancarias tb
       JOIN cuentas_bancarias cb ON cb.id = tb.cuenta_bancaria_id
       WHERE tb.id = ? AND tb.organizacion_id = ?`,
      [req.params.id, req.organizacion.id]
    );

    if (!trans.length) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    if (trans[0].venta_vinculada_id || trans[0].gasto_vinculado_id) {
      return res.status(400).json({ error: 'No se puede eliminar transacciones vinculadas' });
    }

    const ajuste = trans[0].tipo === 'ingreso' 
      ? -parseFloat(trans[0].monto) 
      : parseFloat(trans[0].monto);

    await connection.query(
      'UPDATE cuentas_bancarias SET saldo_actual = saldo_actual + ? WHERE id = ?',
      [ajuste, trans[0].cuenta_bancaria_id]
    );

    if (trans[0].es_transferencia_interna && trans[0].id_par_transferencia) {
      const [parTrans] = await connection.query(
        'SELECT * FROM transacciones_bancarias WHERE id_par_transferencia = ? AND id != ?',
        [trans[0].id_par_transferencia, req.params.id]
      );

      if (parTrans.length) {
        const parAjuste = parTrans[0].tipo === 'ingreso' 
          ? -parseFloat(parTrans[0].monto) 
          : parseFloat(parTrans[0].monto);

        await connection.query(
          'UPDATE cuentas_bancarias SET saldo_actual = saldo_actual + ? WHERE id = ?',
          [parAjuste, parTrans[0].cuenta_bancaria_id]
        );

        await connection.query(
          'DELETE FROM transacciones_bancarias WHERE id_par_transferencia = ?',
          [trans[0].id_par_transferencia]
        );
      }
    } else {
      await connection.query(
        'DELETE FROM transacciones_bancarias WHERE id = ?',
        [req.params.id]
      );
    }

    await connection.commit();
    res.json({ mensaje: 'Transacción eliminada' });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

module.exports = router;
