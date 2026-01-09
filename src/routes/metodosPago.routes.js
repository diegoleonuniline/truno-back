const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { auth, requireOrg } = require('../middlewares/auth.middleware');

// GET /api/metodos-pago
router.get('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { activo } = req.query;
    
    let sql = 'SELECT * FROM metodos_pago WHERE organizacion_id = ?';
    const params = [req.organizacion.id];

    if (activo !== undefined) {
      sql += ' AND activo = ?';
      params.push(activo === 'true' || activo === '1');
    }

    sql += ' ORDER BY nombre';
    const [metodos_pago] = await db.query(sql, params);

    res.json({ metodos_pago });
  } catch (error) {
    next(error);
  }
});

// GET /api/metodos-pago/:id
router.get('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM metodos_pago WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Método de pago no encontrado' });
    }

    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

// POST /api/metodos-pago
router.post('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { nombre, clave, descripcion, activo = true } = req.body;

    if (!nombre) {
      return res.status(400).json({ error: 'Nombre es requerido' });
    }

    const id = uuidv4();
    await db.query(
      `INSERT INTO metodos_pago (id, organizacion_id, nombre, clave, descripcion, activo)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, req.organizacion.id, nombre, clave || null, descripcion || null, activo]
    );

    res.status(201).json({ 
      id, 
      metodo_pago: { id, nombre, clave, descripcion, activo }, 
      mensaje: 'Método de pago creado' 
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Ya existe un método de pago con esa clave' });
    }
    next(error);
  }
});

// PUT /api/metodos-pago/:id
router.put('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const { nombre, clave, descripcion, activo } = req.body;

    const [result] = await db.query(
      `UPDATE metodos_pago SET
       nombre = COALESCE(?, nombre),
       clave = ?,
       descripcion = ?,
       activo = COALESCE(?, activo)
       WHERE id = ? AND organizacion_id = ?`,
      [nombre, clave || null, descripcion || null, activo, req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Método de pago no encontrado' });
    }

    res.json({ mensaje: 'Método de pago actualizado' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Ya existe un método de pago con esa clave' });
    }
    next(error);
  }
});

// DELETE /api/metodos-pago/:id
router.delete('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const [result] = await db.query(
      'DELETE FROM metodos_pago WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Método de pago no encontrado' });
    }

    res.json({ mensaje: 'Método de pago eliminado' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
