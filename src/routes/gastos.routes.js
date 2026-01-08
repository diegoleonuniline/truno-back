const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth, requireOrg, requireModule } = require('../middlewares/auth.middleware');

// GET /api/gastos
router.get('/', auth, requireOrg, requireModule('gastos'), async (req, res, next) => {
  try {
    const { 
      contacto_id, estatus, categoria, fecha_inicio, fecha_fin, 
      buscar, pagina = 1, limite = 50 
    } = req.query;

    let sql = `
      SELECT g.*, c.nombre as nombre_contacto, c.rfc as rfc_contacto
      FROM gastos g
      LEFT JOIN contactos c ON c.id = g.contacto_id
      WHERE g.organizacion_id = ?
    `;
    const params = [req.organizacion.id];

    if (contacto_id) {
      sql += ' AND g.contacto_id = ?';
      params.push(contacto_id);
    }
    if (estatus) {
      sql += ' AND g.estatus_pago = ?';
      params.push(estatus);
    }
    if (categoria) {
      sql += ' AND g.categoria = ?';
      params.push(categoria);
    }
    if (fecha_inicio) {
      sql += ' AND g.fecha >= ?';
      params.push(fecha_inicio);
    }
    if (fecha_fin) {
      sql += ' AND g.fecha <= ?';
      params.push(fecha_fin);
    }
    if (buscar) {
      sql += ' AND (g.numero_gasto LIKE ? OR g.uuid_cfdi LIKE ? OR c.nombre LIKE ?)';
      params.push(`%${buscar}%`, `%${buscar}%`, `%${buscar}%`);
    }

    const countSql = sql.replace(/SELECT .* FROM/, 'SELECT COUNT(*) as total FROM');
    const [[{ total }]] = await db.query(countSql, params);

    const offset = (parseInt(pagina) - 1) * parseInt(limite);
    sql += ' ORDER BY g.fecha DESC, g.creado_en DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limite), offset);

    const [gastos] = await db.query(sql, params);

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
    next(error);
  }
});

// GET /api/gastos/:id
router.get('/:id', auth, requireOrg, requireModule('gastos'), async (req, res, next) => {
  try {
    const [gastos] = await db.query(
      `SELECT g.*, c.nombre as nombre_contacto, c.rfc as rfc_contacto, c.correo as correo_contacto
       FROM gastos g
       LEFT JOIN contactos c ON c.id = g.contacto_id
       WHERE g.id = ? AND g.organizacion_id = ?`,
      [req.params.id, req.organizacion.id]
    );

    if (!gastos.length) {
      return res.status(404).json({ error: 'Gasto no encontrado' });
    }

    res.json(gastos[0]);
  } catch (error) {
    next(error);
  }
});

// POST /api/gastos
router.post('/', auth, requireOrg, requireModule('gastos'), [
  body('fecha').isDate(),
  body('total').isDecimal()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { 
      contacto_id, numero_gasto, fecha, fecha_vencimiento, 
      subtotal, impuesto, descuento, total, categoria,
      moneda, tipo_cambio, notas, uuid_cfdi, folio_cfdi, serie_cfdi,
      url_archivo_xml, url_archivo_pdf
    } = req.body;

    const gastoId = uuidv4();

    await db.query(
      `INSERT INTO gastos 
       (id, organizacion_id, contacto_id, numero_gasto, fecha, fecha_vencimiento, uuid_cfdi, folio_cfdi, serie_cfdi,
        subtotal, impuesto, descuento, total, categoria, moneda, tipo_cambio, notas, url_archivo_xml, url_archivo_pdf, creado_por) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gastoId, req.organizacion.id, contacto_id || null, numero_gasto || null, fecha, fecha_vencimiento || null,
       uuid_cfdi || null, folio_cfdi || null, serie_cfdi || null, 
       subtotal || total, impuesto || 0, descuento || 0, total, categoria || null,
       moneda || 'MXN', tipo_cambio || 1, notas || null, url_archivo_xml || null, url_archivo_pdf || null, req.usuario.id]
    );

    res.status(201).json({ id: gastoId, total });
  } catch (error) {
    next(error);
  }
});

// PUT /api/gastos/:id
router.put('/:id', auth, requireOrg, requireModule('gastos'), async (req, res, next) => {
  try {
    const { 
      contacto_id, numero_gasto, fecha, fecha_vencimiento, categoria, notas,
      uuid_cfdi, folio_cfdi, serie_cfdi, url_archivo_xml, url_archivo_pdf
    } = req.body;

    const [result] = await db.query(
      `UPDATE gastos SET 
       contacto_id = COALESCE(?, contacto_id),
       numero_gasto = COALESCE(?, numero_gasto),
       fecha = COALESCE(?, fecha),
       fecha_vencimiento = COALESCE(?, fecha_vencimiento),
       categoria = COALESCE(?, categoria),
       notas = COALESCE(?, notas),
       uuid_cfdi = COALESCE(?, uuid_cfdi),
       folio_cfdi = COALESCE(?, folio_cfdi),
       serie_cfdi = COALESCE(?, serie_cfdi),
       url_archivo_xml = COALESCE(?, url_archivo_xml),
       url_archivo_pdf = COALESCE(?, url_archivo_pdf)
       WHERE id = ? AND organizacion_id = ?`,
      [contacto_id, numero_gasto, fecha, fecha_vencimiento, categoria, notas, uuid_cfdi, folio_cfdi, serie_cfdi,
       url_archivo_xml, url_archivo_pdf, req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Gasto no encontrado' });
    }

    res.json({ mensaje: 'Gasto actualizado' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/gastos/:id
router.delete('/:id', auth, requireOrg, requireModule('gastos'), async (req, res, next) => {
  try {
    const [gastos] = await db.query(
      'SELECT monto_pagado FROM gastos WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (!gastos.length) {
      return res.status(404).json({ error: 'Gasto no encontrado' });
    }

    if (parseFloat(gastos[0].monto_pagado) > 0) {
      return res.status(400).json({ error: 'No se puede eliminar un gasto con pagos registrados' });
    }

    await db.query(
      'UPDATE transacciones_bancarias SET gasto_vinculado_id = NULL WHERE gasto_vinculado_id = ?',
      [req.params.id]
    );

    await db.query('DELETE FROM gastos WHERE id = ?', [req.params.id]);

    res.json({ mensaje: 'Gasto eliminado' });
  } catch (error) {
    next(error);
  }
});

// GET /api/gastos/categorias
router.get('/meta/categorias', auth, requireOrg, async (req, res, next) => {
  try {
    const [categorias] = await db.query(
      `SELECT DISTINCT categoria, COUNT(*) as total 
       FROM gastos 
       WHERE organizacion_id = ? AND categoria IS NOT NULL
       GROUP BY categoria
       ORDER BY total DESC`,
      [req.organizacion.id]
    );

    res.json(categorias);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
