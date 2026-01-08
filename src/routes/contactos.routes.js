const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth, requireOrg, requireModule } = require('../middlewares/auth.middleware');

// GET /api/contactos
router.get('/', auth, requireOrg, requireModule('contactos'), async (req, res, next) => {
  try {
    const { tipo, buscar, pagina = 1, limite = 50 } = req.query;

    let sql = `
      SELECT c.*,
             (SELECT COUNT(*) FROM ventas WHERE contacto_id = c.id) as total_ventas,
             (SELECT COUNT(*) FROM gastos WHERE contacto_id = c.id) as total_gastos,
             (SELECT COALESCE(SUM(total - monto_pagado), 0) FROM ventas WHERE contacto_id = c.id AND estatus_pago IN ('pendiente', 'parcial')) as por_cobrar,
             (SELECT COALESCE(SUM(total - monto_pagado), 0) FROM gastos WHERE contacto_id = c.id AND estatus_pago IN ('pendiente', 'parcial')) as por_pagar
      FROM contactos c
      WHERE c.organizacion_id = ? AND c.activo = 1
    `;
    const params = [req.organizacion.id];

    if (tipo) {
      if (tipo === 'cliente') {
        sql += " AND c.tipo IN ('cliente', 'ambos')";
      } else if (tipo === 'proveedor') {
        sql += " AND c.tipo IN ('proveedor', 'ambos')";
      }
    }

    if (buscar) {
      sql += ' AND (c.nombre LIKE ? OR c.nombre_legal LIKE ? OR c.rfc LIKE ? OR c.correo LIKE ?)';
      params.push(`%${buscar}%`, `%${buscar}%`, `%${buscar}%`, `%${buscar}%`);
    }

    const countSql = sql.replace(/SELECT .* FROM/, 'SELECT COUNT(*) as total FROM');
    const [[{ total }]] = await db.query(countSql, params);

    const offset = (parseInt(pagina) - 1) * parseInt(limite);
    sql += ' ORDER BY c.nombre LIMIT ? OFFSET ?';
    params.push(parseInt(limite), offset);

    const [contactos] = await db.query(sql, params);

    res.json({
      contactos,
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

// GET /api/contactos/:id
router.get('/:id', auth, requireOrg, requireModule('contactos'), async (req, res, next) => {
  try {
    const [contactos] = await db.query(
      `SELECT c.*,
              (SELECT COALESCE(SUM(total), 0) FROM ventas WHERE contacto_id = c.id) as total_ventas,
              (SELECT COALESCE(SUM(total), 0) FROM gastos WHERE contacto_id = c.id) as total_gastos
       FROM contactos c
       WHERE c.id = ? AND c.organizacion_id = ?`,
      [req.params.id, req.organizacion.id]
    );

    if (!contactos.length) {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }

    res.json(contactos[0]);
  } catch (error) {
    next(error);
  }
});

// POST /api/contactos
router.post('/', auth, requireOrg, requireModule('contactos'), [
  body('nombre').trim().notEmpty(),
  body('tipo').isIn(['cliente', 'proveedor', 'ambos'])
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { 
      tipo, nombre, nombre_legal, rfc, regimen_fiscal, correo, telefono, 
      direccion, ciudad, estado, codigo_postal, pais, dias_credito, limite_credito, notas 
    } = req.body;

    const contactoId = uuidv4();

    await db.query(
      `INSERT INTO contactos 
       (id, organizacion_id, tipo, nombre, nombre_legal, rfc, regimen_fiscal, correo, telefono, direccion, ciudad, estado, codigo_postal, pais, dias_credito, limite_credito, notas, creado_por) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [contactoId, req.organizacion.id, tipo, nombre, nombre_legal || null, rfc || null, 
       regimen_fiscal || null, correo || null, telefono || null, direccion || null, ciudad || null,
       estado || null, codigo_postal || null, pais || 'MX', dias_credito || 0, 
       limite_credito || null, notas || null, req.usuario.id]
    );

    res.status(201).json({ id: contactoId, nombre, tipo });
  } catch (error) {
    next(error);
  }
});

// PUT /api/contactos/:id
router.put('/:id', auth, requireOrg, requireModule('contactos'), async (req, res, next) => {
  try {
    const { 
      tipo, nombre, nombre_legal, rfc, regimen_fiscal, correo, telefono, 
      direccion, ciudad, estado, codigo_postal, pais, dias_credito, limite_credito, notas 
    } = req.body;

    const [result] = await db.query(
      `UPDATE contactos SET 
       tipo = COALESCE(?, tipo),
       nombre = COALESCE(?, nombre),
       nombre_legal = COALESCE(?, nombre_legal),
       rfc = COALESCE(?, rfc),
       regimen_fiscal = COALESCE(?, regimen_fiscal),
       correo = COALESCE(?, correo),
       telefono = COALESCE(?, telefono),
       direccion = COALESCE(?, direccion),
       ciudad = COALESCE(?, ciudad),
       estado = COALESCE(?, estado),
       codigo_postal = COALESCE(?, codigo_postal),
       pais = COALESCE(?, pais),
       dias_credito = COALESCE(?, dias_credito),
       limite_credito = COALESCE(?, limite_credito),
       notas = COALESCE(?, notas)
       WHERE id = ? AND organizacion_id = ?`,
      [tipo, nombre, nombre_legal, rfc, regimen_fiscal, correo, telefono, direccion, ciudad, estado, 
       codigo_postal, pais, dias_credito, limite_credito, notas, req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }

    res.json({ mensaje: 'Contacto actualizado' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/contactos/:id
router.delete('/:id', auth, requireOrg, requireModule('contactos'), async (req, res, next) => {
  try {
    const [result] = await db.query(
      'UPDATE contactos SET activo = 0 WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }

    res.json({ mensaje: 'Contacto eliminado' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
