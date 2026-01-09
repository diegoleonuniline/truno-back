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
    console.log('🆕 ========== POST /api/transacciones ==========');
    console.log('📦 Body recibido:', JSON.stringify(req.body, null, 2));
    
    const { 
      cuenta_bancaria_id, tipo, monto, fecha, contacto_id,
      descripcion, referencia, comprobante_url,
      gasto_id, venta_id
    } = req.body;

    console.log('🔗 gasto_id recibido:', gasto_id);
    console.log('🔗 venta_id recibido:', venta_id);

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

    // ========== VINCULAR GASTO (bidireccional) ==========
    if (gasto_id) {
      console.log('🔗 Vinculando gasto:', gasto_id);
      const [updateResult] = await db.query(
        'UPDATE gastos SET transaccion_id = ? WHERE id = ? AND organizacion_id = ?', 
        [transaccionId, gasto_id, req.organizacion.id]
      );
      console.log('🔗 Resultado UPDATE gastos:', updateResult.affectedRows, 'filas afectadas');
    }

    // ========== VINCULAR VENTA (bidireccional) + actualizar monto_cobrado ==========
    if (venta_id) {
      console.log('🔗 Vinculando venta:', venta_id);
      
      // Obtener venta actual
      const [ventas] = await db.query(
        'SELECT id, total, monto_cobrado, estatus_pago FROM ventas WHERE id = ? AND organizacion_id = ?',
        [venta_id, req.organizacion.id]
      );
      
      if (ventas.length) {
        const venta = ventas[0];
        const totalVenta = parseFloat(venta.total) || 0;
        const montoCobradoActual = parseFloat(venta.monto_cobrado) || 0;
        const nuevoMontoCobrado = montoCobradoActual + montoNum;
        
        // Determinar nuevo estatus
        let nuevoEstatus = 'pendiente';
        if (nuevoMontoCobrado >= totalVenta) {
          nuevoEstatus = 'pagado';
        } else if (nuevoMontoCobrado > 0) {
          nuevoEstatus = 'parcial';
        }
        
        console.log('💰 Venta - Total:', totalVenta, 'Cobrado anterior:', montoCobradoActual, 'Nuevo cobrado:', nuevoMontoCobrado, 'Estatus:', nuevoEstatus);
        
        // Actualizar venta con monto_cobrado, estatus y transaccion_id
        const [updateResult] = await db.query(
          `UPDATE ventas SET 
           transaccion_id = ?, 
           monto_cobrado = ?, 
           estatus_pago = ?
           WHERE id = ? AND organizacion_id = ?`,
          [transaccionId, nuevoMontoCobrado, nuevoEstatus, venta_id, req.organizacion.id]
        );
        console.log('🔗 Resultado UPDATE ventas:', updateResult.affectedRows, 'filas afectadas');
      } else {
        console.log('⚠️ Venta no encontrada:', venta_id);
      }
    }

    res.status(201).json({ id: transaccionId, transaccion: { id: transaccionId, saldo_despues: nuevoSaldo } });
  } catch (error) {
    next(error);
  }
});

// PUT /api/transacciones/:id
router.put('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    console.log('✏️ ========== PUT /api/transacciones/:id ==========');
    console.log('📦 Body recibido:', JSON.stringify(req.body, null, 2));
    
    const { descripcion, referencia, comprobante_url, contacto_id, gasto_id, venta_id } = req.body;

    // Obtener transacción actual
    const [txActual] = await db.query(
      'SELECT * FROM transacciones WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (!txActual.length) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    const tx = txActual[0];
    const montoNum = parseFloat(tx.monto) || 0;
    const oldGastoId = tx.gasto_id;
    const oldVentaId = tx.venta_id;
    const newGastoId = gasto_id !== undefined ? gasto_id : oldGastoId;
    const newVentaId = venta_id !== undefined ? venta_id : oldVentaId;

    // ========== SINCRONIZAR GASTO (bidireccional) ==========
    if (gasto_id !== undefined && gasto_id !== oldGastoId) {
      // Desvincular gasto anterior
      if (oldGastoId) {
        console.log('🔗 Desvinculando gasto anterior:', oldGastoId);
        await db.query('UPDATE gastos SET transaccion_id = NULL WHERE id = ?', [oldGastoId]);
      }
      // Vincular nuevo gasto
      if (newGastoId) {
        console.log('🔗 Vinculando nuevo gasto:', newGastoId);
        await db.query(
          'UPDATE gastos SET transaccion_id = ? WHERE id = ? AND organizacion_id = ?',
          [req.params.id, newGastoId, req.organizacion.id]
        );
      }
    }

    // ========== SINCRONIZAR VENTA (bidireccional) + monto_cobrado ==========
    if (venta_id !== undefined && venta_id !== oldVentaId) {
      // Desvincular venta anterior y restar monto_cobrado
      if (oldVentaId) {
        console.log('🔗 Desvinculando venta anterior:', oldVentaId);
        const [oldVentas] = await db.query(
          'SELECT total, monto_cobrado FROM ventas WHERE id = ?', [oldVentaId]
        );
        if (oldVentas.length) {
          const oldVenta = oldVentas[0];
          const nuevoMontoCobrado = Math.max(0, (parseFloat(oldVenta.monto_cobrado) || 0) - montoNum);
          const totalVenta = parseFloat(oldVenta.total) || 0;
          let nuevoEstatus = 'pendiente';
          if (nuevoMontoCobrado >= totalVenta) nuevoEstatus = 'pagado';
          else if (nuevoMontoCobrado > 0) nuevoEstatus = 'parcial';
          
          await db.query(
            'UPDATE ventas SET transaccion_id = NULL, monto_cobrado = ?, estatus_pago = ? WHERE id = ?',
            [nuevoMontoCobrado, nuevoEstatus, oldVentaId]
          );
        }
      }
      // Vincular nueva venta y sumar monto_cobrado
      if (newVentaId) {
        console.log('🔗 Vinculando nueva venta:', newVentaId);
        const [newVentas] = await db.query(
          'SELECT total, monto_cobrado FROM ventas WHERE id = ? AND organizacion_id = ?',
          [newVentaId, req.organizacion.id]
        );
        if (newVentas.length) {
          const newVenta = newVentas[0];
          const nuevoMontoCobrado = (parseFloat(newVenta.monto_cobrado) || 0) + montoNum;
          const totalVenta = parseFloat(newVenta.total) || 0;
          let nuevoEstatus = 'pendiente';
          if (nuevoMontoCobrado >= totalVenta) nuevoEstatus = 'pagado';
          else if (nuevoMontoCobrado > 0) nuevoEstatus = 'parcial';
          
          await db.query(
            'UPDATE ventas SET transaccion_id = ?, monto_cobrado = ?, estatus_pago = ? WHERE id = ? AND organizacion_id = ?',
            [req.params.id, nuevoMontoCobrado, nuevoEstatus, newVentaId, req.organizacion.id]
          );
        }
      }
    }

    // Actualizar transacción
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
       contacto_id || null, newGastoId || null, newVentaId || null, 
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
    console.log('🗑️ ========== DELETE /api/transacciones/:id ==========');
    
    // Obtener transacción
    const [trans] = await db.query(
      'SELECT * FROM transacciones WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (!trans.length) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    const tx = trans[0];
    const montoNum = parseFloat(tx.monto) || 0;

    // Revertir saldo de cuenta
    const ajuste = tx.tipo === 'ingreso' ? -montoNum : montoNum;
    await db.query('UPDATE cuentas_bancarias SET saldo_actual = saldo_actual + ? WHERE id = ?', 
      [ajuste, tx.cuenta_bancaria_id]);

    // Limpiar referencia en gasto si existe
    if (tx.gasto_id) {
      console.log('🔗 Desvinculando gasto:', tx.gasto_id);
      await db.query('UPDATE gastos SET transaccion_id = NULL WHERE id = ?', [tx.gasto_id]);
    }

    // Limpiar referencia en venta y restar monto_cobrado
    if (tx.venta_id) {
      console.log('🔗 Desvinculando venta:', tx.venta_id);
      const [ventas] = await db.query(
        'SELECT total, monto_cobrado FROM ventas WHERE id = ?', [tx.venta_id]
      );
      if (ventas.length) {
        const venta = ventas[0];
        const nuevoMontoCobrado = Math.max(0, (parseFloat(venta.monto_cobrado) || 0) - montoNum);
        const totalVenta = parseFloat(venta.total) || 0;
        let nuevoEstatus = 'pendiente';
        if (nuevoMontoCobrado >= totalVenta) nuevoEstatus = 'pagado';
        else if (nuevoMontoCobrado > 0) nuevoEstatus = 'parcial';
        
        await db.query(
          'UPDATE ventas SET transaccion_id = NULL, monto_cobrado = ?, estatus_pago = ? WHERE id = ?',
          [nuevoMontoCobrado, nuevoEstatus, tx.venta_id]
        );
        console.log('💰 Venta actualizada - Nuevo monto_cobrado:', nuevoMontoCobrado, 'Estatus:', nuevoEstatus);
      }
    }

    // Eliminar transacción
    await db.query('DELETE FROM transacciones WHERE id = ?', [req.params.id]);

    res.json({ mensaje: 'Transacción eliminada' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
