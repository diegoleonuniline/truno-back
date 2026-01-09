const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { auth, requireOrg } = require('../middlewares/auth.middleware');

// GET /api/gastos
router.get('/', auth, requireOrg, async (req, res, next) => {
  try {
    console.log('📋 GET /api/gastos - Query:', req.query);
    
    const { 
      proveedor_id, estatus, categoria_id, es_fiscal, sin_conciliar,
      buscar, pagina = 1, limite = 20 
    } = req.query;

    let sql = `
      SELECT g.*, 
        c.nombre as nombre_proveedor, c.rfc as rfc_proveedor,
        cat.nombre as nombre_categoria,
        sub.nombre as nombre_subcategoria
      FROM gastos g
      LEFT JOIN contactos c ON c.id = g.proveedor_id
      LEFT JOIN categorias cat ON cat.id = g.categoria_id
      LEFT JOIN subcategorias sub ON sub.id = g.subcategoria_id
      WHERE g.organizacion_id = ?
    `;
    const params = [req.organizacion.id];

    if (proveedor_id) {
      sql += ' AND g.proveedor_id = ?';
      params.push(proveedor_id);
    }
    if (estatus) {
      sql += ' AND g.estatus_pago = ?';
      params.push(estatus);
    }
    if (categoria_id) {
      sql += ' AND g.categoria_id = ?';
      params.push(categoria_id);
    }
    if (es_fiscal === '1' || es_fiscal === 'true') {
      sql += ' AND g.es_fiscal = 1';
    } else if (es_fiscal === '0' || es_fiscal === 'false') {
      sql += ' AND g.es_fiscal = 0';
    }
    if (sin_conciliar === '1') {
      sql += ' AND g.transaccion_id IS NULL';
    }
    if (buscar) {
      sql += ' AND (g.concepto LIKE ? OR g.uuid_cfdi LIKE ? OR c.nombre LIKE ?)';
      params.push(`%${buscar}%`, `%${buscar}%`, `%${buscar}%`);
    }

    const countSql = sql.replace(/SELECT g\.\*.*FROM/s, 'SELECT COUNT(*) as total FROM');
    const [[{ total }]] = await db.query(countSql, params);

    const offset = (parseInt(pagina) - 1) * parseInt(limite);
    sql += ' ORDER BY g.fecha DESC, g.creado_en DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limite), offset);

    const [gastos] = await db.query(sql, params);

    console.log(`✅ GET /api/gastos - Encontrados: ${gastos.length}`);
    
    res.json({
      gastos,
      paginacion: {
        total,
        pagina: parseInt(pagina),
        limite: parseInt(limite),
        paginas: Math.ceil(total / parseInt(limite))
      }
    });
  } catch (error) {
    console.error('❌ GET /api/gastos - Error:', error.message);
    next(error);
  }
});

// GET /api/gastos/:id
router.get('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    console.log('📋 GET /api/gastos/:id -', req.params.id);
    
    const [gastos] = await db.query(
      `SELECT g.*, 
        c.nombre as nombre_proveedor, c.rfc as rfc_proveedor,
        cat.nombre as nombre_categoria,
        sub.nombre as nombre_subcategoria
       FROM gastos g
       LEFT JOIN contactos c ON c.id = g.proveedor_id
       LEFT JOIN categorias cat ON cat.id = g.categoria_id
       LEFT JOIN subcategorias sub ON sub.id = g.subcategoria_id
       WHERE g.id = ? AND g.organizacion_id = ?`,
      [req.params.id, req.organizacion.id]
    );

    if (!gastos.length) {
      console.log('⚠️ GET /api/gastos/:id - No encontrado');
      return res.status(404).json({ error: 'Gasto no encontrado' });
    }

    console.log('✅ GET /api/gastos/:id - Encontrado:', gastos[0].concepto);
    res.json(gastos[0]);
  } catch (error) {
    console.error('❌ GET /api/gastos/:id - Error:', error.message);
    next(error);
  }
});

// POST /api/gastos
router.post('/', auth, requireOrg, async (req, res, next) => {
  try {
    console.log('🆕 ========== POST /api/gastos ==========');
    console.log('📦 Body recibido:', JSON.stringify(req.body, null, 2));
    
    const { 
      concepto, proveedor_id, fecha, fecha_vencimiento, 
      categoria_id, subcategoria_id,
      subtotal, impuesto, total, moneda, metodo_pago,
      es_fiscal, factura_recibida, factura_validada,
      uuid_cfdi, folio_cfdi, transaccion_id, comprobante_url, notas,
      estatus_pago,
      impuestos
    } = req.body;

    console.log('🔗 transaccion_id recibido:', transaccion_id);
    console.log('💰 estatus_pago recibido:', estatus_pago);

    if (!fecha || !total) {
      console.log('❌ Validación fallida: fecha o total faltante');
      return res.status(400).json({ error: 'Fecha y total son requeridos' });
    }

    const gastoId = uuidv4();
    const estatusFinal = estatus_pago || 'pendiente';
    const montoPagado = estatusFinal === 'pagado' ? parseFloat(total) : 0;

    console.log('📝 Creando gasto con ID:', gastoId);
    console.log('📝 estatus_pago final:', estatusFinal);
    console.log('📝 monto_pagado:', montoPagado);

    await db.query(
      `INSERT INTO gastos 
       (id, organizacion_id, concepto, proveedor_id, fecha, fecha_vencimiento, 
        categoria_id, subcategoria_id, subtotal, impuesto, total, moneda, metodo_pago,
        es_fiscal, factura_recibida, factura_validada, uuid_cfdi, folio_cfdi,
        transaccion_id, comprobante_url, notas, estatus_pago, monto_pagado, creado_por) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gastoId, req.organizacion.id, concepto || null, proveedor_id || null, 
       fecha, fecha_vencimiento || null, categoria_id || null, subcategoria_id || null,
       subtotal || total, impuesto || 0, total, moneda || 'MXN', metodo_pago || null,
       es_fiscal ? 1 : 0, factura_recibida ? 1 : 0, factura_validada ? 1 : 0,
       uuid_cfdi || null, folio_cfdi || null, transaccion_id || null, 
       comprobante_url || null, notas || null, estatusFinal, montoPagado, req.usuario.id]
    );

    console.log('✅ Gasto insertado en BD');

    // Vincular transacción con este gasto (relación bidireccional)
    if (transaccion_id) {
      console.log('🔗 Vinculando transacción:', transaccion_id, '-> gasto:', gastoId);
      const [updateResult] = await db.query(
        'UPDATE transacciones SET gasto_id = ? WHERE id = ? AND organizacion_id = ?',
        [gastoId, transaccion_id, req.organizacion.id]
      );
      console.log('🔗 Resultado UPDATE transacciones:', updateResult.affectedRows, 'filas afectadas');
    } else {
      console.log('⚠️ No hay transaccion_id para vincular');
    }

    // Guardar impuestos
    if (impuestos && impuestos.length > 0) {
      console.log('💵 Guardando', impuestos.length, 'impuestos');
      for (const imp of impuestos) {
        if (imp.impuesto_id) {
          await db.query(
            `INSERT INTO gasto_impuestos (id, gasto_id, impuesto_id, base, importe)
             VALUES (?, ?, ?, ?, ?)`,
            [uuidv4(), gastoId, imp.impuesto_id, imp.base || subtotal || total, imp.importe || 0]
          );
        }
      }
    }

    console.log('✅ ========== POST /api/gastos COMPLETADO ==========');
    res.status(201).json({ id: gastoId, gasto: { id: gastoId }, mensaje: 'Gasto creado' });
  } catch (error) {
    console.error('❌ POST /api/gastos - Error:', error.message);
    console.error('❌ Stack:', error.stack);
    next(error);
  }
});

// PUT /api/gastos/:id
router.put('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    console.log('✏️ ========== PUT /api/gastos/:id ==========');
    console.log('📝 Gasto ID:', req.params.id);
    console.log('📦 Body recibido:', JSON.stringify(req.body, null, 2));
    
    const { 
      concepto, proveedor_id, fecha, fecha_vencimiento,
      categoria_id, subcategoria_id, subtotal, impuesto, total, moneda, metodo_pago,
      es_fiscal, factura_recibida, factura_validada, uuid_cfdi, folio_cfdi,
      transaccion_id, comprobante_url, notas, estatus_pago
    } = req.body;

    console.log('🔗 transaccion_id recibido:', transaccion_id);
    console.log('💰 estatus_pago recibido:', estatus_pago);

    // Obtener gasto actual para comparar transaccion_id
    const [gastoActual] = await db.query(
      'SELECT transaccion_id, total FROM gastos WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (!gastoActual.length) {
      console.log('❌ Gasto no encontrado');
      return res.status(404).json({ error: 'Gasto no encontrado' });
    }

    console.log('📋 Gasto actual - transaccion_id:', gastoActual[0].transaccion_id);

    // Calcular monto_pagado
    let montoPagado = null;
    if (estatus_pago === 'pagado') {
      montoPagado = total || gastoActual[0].total;
    } else if (estatus_pago === 'pendiente') {
      montoPagado = 0;
    }

    console.log('💰 monto_pagado calculado:', montoPagado);

    const [result] = await db.query(
      `UPDATE gastos SET 
       concepto = COALESCE(?, concepto),
       proveedor_id = ?,
       fecha = COALESCE(?, fecha),
       fecha_vencimiento = ?,
       categoria_id = ?,
       subcategoria_id = ?,
       subtotal = COALESCE(?, subtotal),
       impuesto = COALESCE(?, impuesto),
       total = COALESCE(?, total),
       moneda = COALESCE(?, moneda),
       metodo_pago = ?,
       es_fiscal = COALESCE(?, es_fiscal),
       factura_recibida = COALESCE(?, factura_recibida),
       factura_validada = COALESCE(?, factura_validada),
       uuid_cfdi = ?,
       folio_cfdi = ?,
       transaccion_id = ?,
       comprobante_url = ?,
       notas = ?,
       estatus_pago = COALESCE(?, estatus_pago),
       monto_pagado = COALESCE(?, monto_pagado)
       WHERE id = ? AND organizacion_id = ?`,
      [concepto, proveedor_id || null, fecha, fecha_vencimiento || null,
       categoria_id || null, subcategoria_id || null, subtotal, impuesto, total, moneda, 
       metodo_pago || null, 
       es_fiscal !== undefined ? (es_fiscal ? 1 : 0) : null,
       factura_recibida !== undefined ? (factura_recibida ? 1 : 0) : null,
       factura_validada !== undefined ? (factura_validada ? 1 : 0) : null,
       uuid_cfdi || null, folio_cfdi || null, transaccion_id !== undefined ? transaccion_id : gastoActual[0].transaccion_id,
       comprobante_url || null, notas || null, estatus_pago || null, montoPagado,
       req.params.id, req.organizacion.id]
    );

    console.log('✅ UPDATE gastos - Filas afectadas:', result.affectedRows);

    // Actualizar relación bidireccional con transacciones
    const oldTxId = gastoActual[0].transaccion_id;
    const newTxId = transaccion_id;

    console.log('🔗 oldTxId:', oldTxId, '| newTxId:', newTxId);

    // Si cambió la transacción vinculada
    if (newTxId !== undefined && newTxId !== oldTxId) {
      // Desvincular transacción anterior
      if (oldTxId) {
        console.log('🔗 Desvinculando transacción anterior:', oldTxId);
        await db.query(
          'UPDATE transacciones SET gasto_id = NULL WHERE id = ?',
          [oldTxId]
        );
      }
      // Vincular nueva transacción
      if (newTxId) {
        console.log('🔗 Vinculando nueva transacción:', newTxId);
        const [updateResult] = await db.query(
          'UPDATE transacciones SET gasto_id = ? WHERE id = ? AND organizacion_id = ?',
          [req.params.id, newTxId, req.organizacion.id]
        );
        console.log('🔗 Resultado UPDATE transacciones:', updateResult.affectedRows, 'filas afectadas');
      }
    }

    console.log('✅ ========== PUT /api/gastos/:id COMPLETADO ==========');
    res.json({ mensaje: 'Gasto actualizado' });
  } catch (error) {
    console.error('❌ PUT /api/gastos/:id - Error:', error.message);
    console.error('❌ Stack:', error.stack);
    next(error);
  }
});

// DELETE /api/gastos/:id
router.delete('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    console.log('🗑️ DELETE /api/gastos/:id -', req.params.id);
    
    // Obtener gasto para limpiar relaciones
    const [gasto] = await db.query(
      'SELECT transaccion_id FROM gastos WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (!gasto.length) {
      console.log('❌ Gasto no encontrado');
      return res.status(404).json({ error: 'Gasto no encontrado' });
    }

    // Desvincular transacción si existe
    if (gasto[0].transaccion_id) {
      console.log('🔗 Desvinculando transacción:', gasto[0].transaccion_id);
      await db.query(
        'UPDATE transacciones SET gasto_id = NULL WHERE id = ?',
        [gasto[0].transaccion_id]
      );
    }

    // Eliminar impuestos asociados
    await db.query('DELETE FROM gasto_impuestos WHERE gasto_id = ?', [req.params.id]);
    console.log('✅ Impuestos eliminados');

    // Eliminar gasto
    await db.query(
      'DELETE FROM gastos WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    console.log('✅ Gasto eliminado');
    res.json({ mensaje: 'Gasto eliminado' });
  } catch (error) {
    console.error('❌ DELETE /api/gastos/:id - Error:', error.message);
    next(error);
  }
});

module.exports = router;
