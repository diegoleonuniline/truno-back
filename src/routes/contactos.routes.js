const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { auth, requireOrg } = require('../middlewares/auth.middleware');

// GET /api/contactos
router.get('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { tipo, buscar, pagina = 1, limite = 200 } = req.query;

    let sql = `SELECT * FROM contactos WHERE organizacion_id = ? AND activo = 1`;
    const params = [req.organizacion.id];

    if (tipo) {
      if (tipo === 'cliente') {
        sql += " AND tipo IN ('cliente', 'ambos')";
      } else if (tipo === 'proveedor') {
        sql += " AND tipo IN ('proveedor', 'ambos')";
      } else if (tipo === 'ambos') {
        sql += " AND tipo = 'ambos'";
      }
    }

    if (buscar) {
      sql += ' AND (nombre LIKE ? OR rfc LIKE ? OR email LIKE ? OR telefono LIKE ?)';
      params.push(`%${buscar}%`, `%${buscar}%`, `%${buscar}%`, `%${buscar}%`);
    }

    sql += ' ORDER BY nombre LIMIT ? OFFSET ?';
    params.push(parseInt(limite), (parseInt(pagina) - 1) * parseInt(limite));

    const [contactos] = await db.query(sql, params);

    res.json({ contactos });
  } catch (error) {
    next(error);
  }
});

// GET /api/contactos/:id
router.get('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const [contactos] = await db.query(
      'SELECT * FROM contactos WHERE id = ? AND organizacion_id = ?',
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
router.post('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { 
      tipo, nombre, empresa, email, telefono, rfc, 
      direccion, ciudad, estado, codigo_postal, pais, notas 
    } = req.body;

    if (!nombre) {
      return res.status(400).json({ error: 'Nombre es requerido' });
    }

    const contactoId = uuidv4();

    await db.query(
      `INSERT INTO contactos 
       (id, organizacion_id, tipo, nombre, empresa, email, telefono, rfc, 
        direccion, ciudad, estado, codigo_postal, pais, notas, creado_por) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [contactoId, req.organizacion.id, tipo || 'cliente', nombre, empresa || null, 
       email || null, telefono || null, rfc || null, direccion || null, ciudad || null,
       estado || null, codigo_postal || null, pais || 'MX', notas || null, req.usuario.id]
    );

    res.status(201).json({ id: contactoId, contacto: { id: contactoId, nombre, tipo } });
  } catch (error) {
    next(error);
  }
});

// PUT /api/contactos/:id
router.put('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const { 
      tipo, nombre, empresa, email, telefono, rfc,
      direccion, ciudad, estado, codigo_postal, pais, notas 
    } = req.body;

    const [result] = await db.query(
      `UPDATE contactos SET 
       tipo = COALESCE(?, tipo),
       nombre = COALESCE(?, nombre),
       empresa = ?,
       email = ?,
       telefono = ?,
       rfc = ?,
       direccion = ?,
       ciudad = ?,
       estado = ?,
       codigo_postal = ?,
       pais = COALESCE(?, pais),
       notas = ?
       WHERE id = ? AND organizacion_id = ?`,
      [tipo, nombre, empresa || null, email || null, telefono || null, rfc || null,
       direccion || null, ciudad || null, estado || null, codigo_postal || null,
       pais, notas || null, req.params.id, req.organizacion.id]
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
router.delete('/:id', auth, requireOrg, async (req, res, next) => {
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
