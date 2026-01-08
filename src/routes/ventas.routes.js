const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth, requireOrg, requireModule } = require('../middlewares/auth.middleware');

// GET /api/ventas
router.get('/', auth, requireOrg, requireModule('ventas'), async (req, res, next) => {
  try {
    const { 
      contacto_id, estatus, fecha_inicio, fecha_fin, 
      buscar, pagina = 1, limite = 50 
    } = req.query;

    let sql = `
      SELECT v.*, c.nombre as nombre_contacto, c.rfc as rfc_contacto
      FROM ventas v
      LEFT JOIN contactos c ON c.id = v.contacto_id
      WHERE v.organizacion_id = ?
    `;
    const params = [req.organizacion.id];

    if (contacto_id) {
      sql += ' AND v.contacto_id = ?';
      params.push(contacto_id);
    }
    if (estatus) {
      sql += ' AND v.estatus_pago = ?';
      params.push(estatus);
    }
    if (fecha_inicio) {
      sql += ' AND v.fecha >= ?';
      params.push(fecha_inicio);
    }
    if (fecha_fin) {
      sql += ' AND v.fecha <= ?';
      params.push(fecha_fin);
    }
    if (buscar) {
      sql += ' AND (v.numero_venta LIKE ? OR v.uuid_cfdi LIKE ? OR c.nombre LIKE ?)';
      params.push(`%${buscar}%`, `%${buscar}%`, `%${buscar}%`);
    }

    const countSql = sql.replace(/SELECT .* FROM/, 'SELECT COUNT(*) as total FROM');
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
router.get('/:id', auth, requireOrg, requireModule('ventas'), async (req, res, next) => {
  try {
    const [ventas] = await db.query(
      `SELECT v.*, c.nombre as nombre_contacto, c.rfc as rfc_contacto, c.correo as correo_contacto
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
router.post('/', auth, requireOrg, requireModule('ventas'), [
  body('fecha').isDate(),
  body('total').isDecimal()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { 
      contacto_id, numero_venta, fecha, fecha_vencimiento, 
      subtotal, impuesto, descuento, total,
      moneda, tipo_cambio, notas, uuid_cfdi, folio_cfdi, serie_cfdi,
      url_archivo_xml, url_archivo_pdf
    } = req.body;

    const ventaId = uuidv4();

    await db.query(
      `INSERT INTO ventas 
       (id, organizacion_id, contacto_id, numero_venta, fecha, fecha_vencimiento, uuid_cfdi, folio_cfdi, serie_cfdi,
        subtotal, impuesto, descuento, total, moneda, tipo_cambio, notas, url_archivo_xml, url_archivo_pdf, creado_por) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ventaId, req.organizacion.id, contacto_id || null, numero_venta || null, fecha, fecha_vencimiento || null,
       uuid_cfdi || null, folio_cfdi || null, serie_cfdi || null, 
       subtotal || total, impuesto || 0, descuento || 0, total,
       moneda || 'MXN', tipo_cambio || 1, notas || null, url_archivo_xml || null, url_archivo_pdf || null, req.usuario.id]
    );

    res.status(201).json({ id: ventaId, total });
  } catch (error) {
    next(error);
  }
});

// PUT /api/ventas/:id
router.put('/:id', auth, requireOrg, requireModule('ventas'), async (req, res, next) => {
  try {
    const { 
      contacto_id, numero_venta, fecha, fecha_vencimiento, notas,
      uuid_cfdi, folio_cfdi, serie_cfdi, url_archivo_xml, url_archivo_pdf
    } = req.body;

    const [result] = await db.query(
      `UPDATE ventas SET 
       contacto_id = COALESCE(?, contacto_id),
       numero_venta = COALESCE(?, numero_venta),
       fecha = COALESCE(?, fecha),
       fecha_vencimiento = COALESCE(?, fecha_vencimiento),
       notas = COALESCE(?, notas),
       uuid_cfdi = COALESCE(?, uuid_cfdi),
       folio_cfdi = COALESCE(?, folio_cfdi),
       serie_cfdi = COALESCE(?, serie_cfdi),
       url_archivo_xml = COALESCE(?, url_archivo_xml),
       url_archivo_pdf = COALESCE(?, url_archivo_pdf)
       WHERE id = ? AND organizacion_id = ?`,
      [contacto_id, numero_venta, fecha, fecha_vencimiento, notas, uuid_cfdi, folio_cfdi, serie_cfdi,
       url_archivo_xml, url_archivo_pdf, req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Venta no encontrada' });
    }

    res.json({ mensaje: 'Venta actualizada' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/ventas/:id
router.delete('/:id', auth, requireOrg, requireModule('ventas'), async (req, res, next) => {
  try {
    const [ventas] = await db.query(
      'SELECT monto_pagado FROM ventas WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (!ventas.length) {
      return res.status(404).json({ error: 'Venta no encontrada' });
    }

    if (parseFloat(ventas[0].monto_pagado) > 0) {
      return res.status(400).json({ error: 'No se puede eliminar una venta con pagos registrados' });
    }

    await db.query(
      'UPDATE transacciones_bancarias SET venta_vinculada_id = NULL WHERE venta_vinculada_id = ?',
      [req.params.id]
    );

    await db.query('DELETE FROM ventas WHERE id = ?', [req.params.id]);

    res.json({ mensaje: 'Venta eliminada' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
