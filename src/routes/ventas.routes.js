const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { auth, requireOrg } = require('../middlewares/auth.middleware');

// GET /api/ventas
router.get('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { 
      contacto_id, cliente_id, estatus, fecha_inicio, fecha_fin, 
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
      sql += ' AND v.estatus = ?';
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
      sql += ' AND (v.folio LIKE ? OR v.concepto LIKE ? OR c.nombre LIKE ?)';
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
    const { 
      contacto_id, folio, fecha, fecha_vencimiento, concepto,
      subtotal, impuesto, total, moneda, estatus, notas,
      impuestos // Array de { impuesto_id, base, importe }
    } = req.body;

    if (!fecha || !total) {
      return res.status(400).json({ error: 'Fecha y total son requeridos' });
    }

    const ventaId = uuidv4();

    await db.query(
      `INSERT INTO ventas 
       (id, organizacion_id, contacto_id, folio, fecha, fecha_vencimiento, concepto,
        subtotal, impuesto, total, moneda, estatus, notas, creado_por) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ventaId, req.organizacion.id, contacto_id || null, folio || null, fecha, 
       fecha_vencimiento || null, concepto || null, subtotal || total, impuesto || 0, total,
       moneda || 'MXN', estatus || 'pendiente', notas || null, req.usuario.id]
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

    res.status(201).json({ id: ventaId, mensaje: 'Venta creada' });
  } catch (error) {
    next(error);
  }
});

// PUT /api/ventas/:id
router.put('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const { 
      contacto_id, folio, fecha, fecha_vencimiento, concepto,
      subtotal, impuesto, total, estatus, notas
    } = req.body;

    const [result] = await db.query(
      `UPDATE ventas SET 
       contacto_id = ?,
       folio = ?,
       fecha = COALESCE(?, fecha),
       fecha_vencimiento = ?,
       concepto = ?,
       subtotal = COALESCE(?, subtotal),
       impuesto = COALESCE(?, impuesto),
       total = COALESCE(?, total),
       estatus = COALESCE(?, estatus),
       notas = ?
       WHERE id = ? AND organizacion_id = ?`,
      [contacto_id || null, folio || null, fecha, fecha_vencimiento || null, 
       concepto || null, subtotal, impuesto, total, estatus, notas || null,
       req.params.id, req.organizacion.id]
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
router.delete('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    // Limpiar impuestos primero
    await db.query('DELETE FROM venta_impuestos WHERE venta_id = ?', [req.params.id]).catch(() => {});
    
    const [result] = await db.query(
      'DELETE FROM ventas WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Venta no encontrada' });
    }

    res.json({ mensaje: 'Venta eliminada' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
