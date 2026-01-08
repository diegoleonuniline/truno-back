const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { auth, requireOrg } = require('../middlewares/auth.middleware');

// GET /api/gastos
router.get('/', auth, requireOrg, async (req, res, next) => {
  try {
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

    // Count
    const countSql = sql.replace(/SELECT g\.\*.*FROM/s, 'SELECT COUNT(*) as total FROM');
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
router.get('/:id', auth, requireOrg, async (req, res, next) => {
  try {
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
      return res.status(404).json({ error: 'Gasto no encontrado' });
    }

    res.json(gastos[0]);
  } catch (error) {
    next(error);
  }
});

// POST /api/gastos
router.post('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { 
      concepto, proveedor_id, fecha, fecha_vencimiento, 
      categoria_id, subcategoria_id,
      subtotal, impuesto, total, moneda, metodo_pago,
      es_fiscal, factura_recibida, factura_validada,
      uuid_cfdi, folio_cfdi, transaccion_id, comprobante_url, notas,
      impuestos // Array de { impuesto_id, base, importe }
    } = req.body;

    if (!fecha || !total) {
      return res.status(400).json({ error: 'Fecha y total son requeridos' });
    }

    const gastoId = uuidv4();

    await db.query(
      `INSERT INTO gastos 
       (id, organizacion_id, concepto, proveedor_id, fecha, fecha_vencimiento, 
        categoria_id, subcategoria_id, subtotal, impuesto, total, moneda, metodo_pago,
        es_fiscal, factura_recibida, factura_validada, uuid_cfdi, folio_cfdi,
        transaccion_id, comprobante_url, notas, creado_por) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gastoId, req.organizacion.id, concepto || null, proveedor_id || null, 
       fecha, fecha_vencimiento || null, categoria_id || null, subcategoria_id || null,
       subtotal || total, impuesto || 0, total, moneda || 'MXN', metodo_pago || null,
       es_fiscal ? 1 : 0, factura_recibida ? 1 : 0, factura_validada ? 1 : 0,
       uuid_cfdi || null, folio_cfdi || null, transaccion_id || null, 
       comprobante_url || null, notas || null, req.usuario.id]
    );

    // Guardar impuestos si existen
    if (impuestos && impuestos.length > 0) {
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

    res.status(201).json({ id: gastoId, mensaje: 'Gasto creado' });
  } catch (error) {
    next(error);
  }
});

// PUT /api/gastos/:id
router.put('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const { 
      concepto, proveedor_id, fecha, fecha_vencimiento,
      categoria_id, subcategoria_id, subtotal, impuesto, total, moneda, metodo_pago,
      es_fiscal, factura_recibida, factura_validada, uuid_cfdi, folio_cfdi,
      transaccion_id, comprobante_url, notas
    } = req.body;

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
       es_fiscal = ?,
       factura_recibida = ?,
       factura_validada = ?,
       uuid_cfdi = ?,
       folio_cfdi = ?,
       transaccion_id = ?,
       comprobante_url = ?,
       notas = ?
       WHERE id = ? AND organizacion_id = ?`,
      [concepto, proveedor_id || null, fecha, fecha_vencimiento || null,
       categoria_id || null, subcategoria_id || null, subtotal, impuesto, total, moneda, 
       metodo_pago || null, es_fiscal ? 1 : 0, factura_recibida ? 1 : 0, factura_validada ? 1 : 0,
       uuid_cfdi || null, folio_cfdi || null, transaccion_id || null,
       comprobante_url || null, notas || null, req.params.id, req.organizacion.id]
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
router.delete('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const [result] = await db.query(
      'DELETE FROM gastos WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Gasto no encontrado' });
    }

    res.json({ mensaje: 'Gasto eliminado' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
