const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { auth, requireOrg } = require('../middlewares/auth.middleware');

// GET /api/subcategorias
router.get('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { categoria_id, activo } = req.query;
    
    let sql = `
      SELECT s.*, c.nombre as nombre_categoria
      FROM subcategorias s
      LEFT JOIN categorias c ON c.id = s.categoria_id
      WHERE s.organizacion_id = ?
    `;
    const params = [req.organizacion.id];

    if (categoria_id) {
      sql += ' AND s.categoria_id = ?';
      params.push(categoria_id);
    }
    if (activo !== undefined) {
      sql += ' AND s.activo = ?';
      params.push(activo === 'true' || activo === '1');
    }

    sql += ' ORDER BY c.nombre, s.nombre';
    const [subcategorias] = await db.query(sql, params);

    res.json({ subcategorias });
  } catch (error) {
    next(error);
  }
});

// GET /api/subcategorias/:id
router.get('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT s.*, c.nombre as nombre_categoria
       FROM subcategorias s
       LEFT JOIN categorias c ON c.id = s.categoria_id
       WHERE s.id = ? AND s.organizacion_id = ?`,
      [req.params.id, req.organizacion.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Subcategoría no encontrada' });
    }

    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

// POST /api/subcategorias
router.post('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { nombre, categoria_id, activo = true } = req.body;

    if (!nombre || !categoria_id) {
      return res.status(400).json({ error: 'Nombre y categoría son requeridos' });
    }

    const id = uuidv4();
    await db.query(
      `INSERT INTO subcategorias (id, organizacion_id, categoria_id, nombre, activo)
       VALUES (?, ?, ?, ?, ?)`,
      [id, req.organizacion.id, categoria_id, nombre, activo]
    );

    res.status(201).json({ id, subcategoria: { id, nombre, categoria_id, activo }, mensaje: 'Subcategoría creada' });
  } catch (error) {
    next(error);
  }
});

// PUT /api/subcategorias/:id
router.put('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const { nombre, categoria_id, activo } = req.body;

    const [result] = await db.query(
      `UPDATE subcategorias SET
       nombre = COALESCE(?, nombre),
       categoria_id = COALESCE(?, categoria_id),
       activo = COALESCE(?, activo)
       WHERE id = ? AND organizacion_id = ?`,
      [nombre, categoria_id, activo, req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Subcategoría no encontrada' });
    }

    res.json({ mensaje: 'Subcategoría actualizada' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/subcategorias/:id
router.delete('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const [result] = await db.query(
      'DELETE FROM subcategorias WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Subcategoría no encontrada' });
    }

    res.json({ mensaje: 'Subcategoría eliminada' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
