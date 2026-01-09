const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { auth, requireOrg } = require('../middlewares/auth.middleware');

// GET /api/ventas
router.get('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { 
      contacto_id, cliente_id, estatus, fecha_inicio, fecha_fin,
      fecha_desde, fecha_hasta, por_cobrar,
      buscar, pagina = 1, limite = 20 
    } = req.query;

    let sql = `
      SELECT v.*, c.nombre as nombre_contacto, c.rfc as rfc_contacto
      FROM ventas v
      LEFT JOIN contactos c ON c.id = v.contacto_id
      WHERE v.organizacion_id = ?
    `;
    const params = [req.organizacion.id];

    if (contacto_id || cliente_id) {
      sql += ' AND v.contacto_id = ?';
      params.push(contacto_id || cliente_id);
    }
    if (estatus) {
      sql += ' AND v.estatus_pago = ?';
      params.push(estatus);
    }
    // Filtro por cobrar: saldo > 0
    if (por_cobrar === '1') {
      sql += ' AND (v.total - COALESCE(v.monto_cobrado, 0)) > 0';
    }
    // Filtros de fecha (soporta ambos nombres)
    if (fecha_inicio || fecha_desde) {
      sql += ' AND v.fecha >= ?';
      params.push(fecha_inicio || fecha_desde);
    }
    if (fecha_fin || fecha_hasta) {
      sql += ' AND v.fecha <= ?';
      params.push(fecha_fin || fecha_hasta);
    }
    if (buscar) {
      sql += ' AND (v.folio LIKE ? OR v.descripcion LIKE ? OR c.nombre LIKE ?)';
      params.push(`%${buscar}%`, `%${buscar}%`, `%${buscar}%`);
    }

    const countSql = sql.replace(/SELECT v\.\*.*FROM/s, 'SELECT COUNT(*) as total FROM');
    const [[{ total }]] = await db.query(countSql, params);

    const offset = (parseInt(pagina) - 1) * parseInt(limite);
    sql += ' ORDER BY v.fecha DESC, v.creado_en DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limite), offset);

    const [ventas] = await db.query(sql, params);

    res.json({
      ventas,
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

// GET /api/ventas/:id
router.get('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const [ventas] = await db.query(
      `SELECT v.*, c.nombre as nombre_contacto, c.rfc as rfc_contacto
       FROM ventas v
       LEFT JOIN contactos c ON c.id = v.contacto_id
       WHERE v.id = ? AND v.organizacion_id = ?`,
      [req.params.id, req.organizacion.id]
    );

    if (!ventas.length) {
      return res.status(404).json({ error: 'Venta no encontrada' });
    }

    res.json(ventas[0]);
  } catch (error) {
    next(error);
  }
});

// POST /api/ventas
router.post('/', auth, requireOrg, async (req, res, next) => {
  try {
    console.log('🆕 ========== POST /api/ventas ==========');
    console.log('📦 Body recibido:', JSON.stringify(req.body, null, 2));
    
    const { 
      contacto_id, folio, fecha, fecha_vencimiento, descripcion, concepto,
      subtotal, impuesto, total, moneda, tipo_cambio, estatus_pago,
      uuid_cfdi, folio_cfdi, notas,
      impuestos
    } = req.body;

    if (!fecha || !total) {
      return res.status(400).json({ error: 'Fecha y total son requeridos' });
    }

    const ventaId = uuidv4();
    const estatusFinal = estatus_pago || 'pendiente';
    const montoCobrado = estatusFinal === 'pagado' ? parseFloat(total) : 0;

    await db.query(
      `INSERT INTO ventas 
       (id, organizacion_id, contacto_id, folio, fecha, fecha_vencimiento, descripcion,
        subtotal, impuesto, total, moneda, tipo_cambio, estatus_pago, monto_cobrado,
        uuid_cfdi, folio_cfdi, notas, creado_por) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ventaId, req.organizacion.id, contacto_id || null, folio || null, fecha, 
       fecha_vencimiento || null, descripcion || concepto || null, 
       subtotal || total, impuesto || 0, total,
       moneda || 'MXN', tipo_cambio || 1, estatusFinal, montoCobrado,
       uuid_cfdi || null, folio_cfdi || null, notas || null, req.usuario.id]
    );

    // Guardar impuestos
    if (impuestos && impuestos.length > 0) {
      for (const imp of impuestos) {
        if (imp.impuesto_id) {
          await db.query(
            `INSERT INTO venta_impuestos (id, venta_id, impuesto_id, base, importe)
             VALUES (?, ?, ?, ?, ?)`,
            [uuidv4(), ventaId, imp.impuesto_id, imp.base || subtotal || total, imp.importe || 0]
          );
        }
      }
    }

    console.log('✅ Venta creada:', ventaId);
    res.status(201).json({ id: ventaId, venta: { id: ventaId }, mensaje: 'Venta creada' });
  } catch (error) {
    console.error('❌ Error creando venta:', error);
    next(error);
  }
});

// PUT /api/ventas/:id
router.put('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    console.log('✏️ ========== PUT /api/ventas/:id ==========');
    console.log('📦 Body recibido:', JSON.stringify(req.body, null, 2));
    
    const { 
      contacto_id, folio, fecha, fecha_vencimiento, descripcion, concepto,
      subtotal, impuesto, total, moneda, tipo_cambio, estatus_pago, monto_cobrado,
      uuid_cfdi, folio_cfdi, notas
    } = req.body;

    // Obtener venta actual para calcular monto_cobrado si cambia estatus
    const [ventaActual] = await db.query(
      'SELECT total, monto_cobrado, estatus_pago FROM ventas WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (!ventaActual.length) {
      return res.status(404).json({ error: 'Venta no encontrada' });
    }

    // Calcular monto_cobrado si se actualiza manualmente
    let nuevoMontoCobrado = monto_cobrado;
    if (monto_cobrado === undefined && estatus_pago) {
      if (estatus_pago === 'pagado') {
        nuevoMontoCobrado = total || ventaActual[0].total;
      } else if (estatus_pago === 'pendiente') {
        nuevoMontoCobrado = 0;
      }
    }

    const [result] = await db.query(
      `UPDATE ventas SET 
       contacto_id = ?,
       folio = ?,
       fecha = COALESCE(?, fecha),
       fecha_vencimiento = ?,
       descripcion = ?,
       subtotal = COALESCE(?, subtotal),
       impuesto = COALESCE(?, impuesto),
       total = COALESCE(?, total),
       moneda = COALESCE(?, moneda),
       tipo_cambio = COALESCE(?, tipo_cambio),
       estatus_pago = COALESCE(?, estatus_pago),
       monto_cobrado = COALESCE(?, monto_cobrado),
       uuid_cfdi = ?,
       folio_cfdi = ?,
       notas = ?
       WHERE id = ? AND organizacion_id = ?`,
      [contacto_id || null, folio || null, fecha, fecha_vencimiento || null, 
       descripcion || concepto || null, subtotal, impuesto, total, moneda, tipo_cambio,
       estatus_pago, nuevoMontoCobrado, uuid_cfdi || null, folio_cfdi || null, notas || null,
       req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Venta no encontrada' });
    }

    console.log('✅ Venta actualizada:', req.params.id);
    res.json({ mensaje: 'Venta actualizada' });
  } catch (error) {
    console.error('❌ Error actualizando venta:', error);
    next(error);
  }
});

// DELETE /api/ventas/:id
router.delete('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    console.log('🗑️ ========== DELETE /api/ventas/:id ==========');
    
    // Obtener venta para limpiar transacciones vinculadas
    const [venta] = await db.query(
      'SELECT transaccion_id FROM ventas WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (!venta.length) {
      return res.status(404).json({ error: 'Venta no encontrada' });
    }

    // Desvincular transacciones que apuntan a esta venta
    await db.query('UPDATE transacciones SET venta_id = NULL WHERE venta_id = ?', [req.params.id]);

    // Limpiar impuestos
    await db.query('DELETE FROM venta_impuestos WHERE venta_id = ?', [req.params.id]).catch(() => {});
    
    // Eliminar venta
    const [result] = await db.query(
      'DELETE FROM ventas WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Venta no encontrada' });
    }

    console.log('✅ Venta eliminada:', req.params.id);
    res.json({ mensaje: 'Venta eliminada' });
  } catch (error) {
    console.error('❌ Error eliminando venta:', error);
    next(error);
  }
});

module.exports = router;
