const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { auth, requireOrg } = require('../middlewares/auth.middleware');

// GET /api/categorias
router.get('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { tipo } = req.query;

    let sql = 'SELECT * FROM categorias WHERE organizacion_id = ? AND activo = 1';
    const params = [req.organizacion.id];

    if (tipo) {
      sql += ' AND tipo = ?';
      params.push(tipo);
    }

    sql += ' ORDER BY nombre';

    const [categorias] = await db.query(sql, params);

    res.json({ categorias });
  } catch (error) {
    next(error);
  }
});

// GET /api/categorias/:id
router.get('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const [categorias] = await db.query(
      'SELECT * FROM categorias WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (!categorias.length) {
      return res.status(404).json({ error: 'Categoría no encontrada' });
    }

    res.json(categorias[0]);
  } catch (error) {
    next(error);
  }
});

// POST /api/categorias
router.post('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { nombre, descripcion, tipo } = req.body;

    if (!nombre) {
      return res.status(400).json({ error: 'Nombre es requerido' });
    }

    const categoriaId = uuidv4();

    await db.query(
      `INSERT INTO categorias (id, organizacion_id, nombre, descripcion, tipo, creado_por) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [categoriaId, req.organizacion.id, nombre, descripcion || null, tipo || 'gasto', req.usuario.id]
    );

    res.status(201).json({ id: categoriaId, categoria: { id: categoriaId, nombre, tipo } });
  } catch (error) {
    next(error);
  }
});

// PUT /api/categorias/:id
router.put('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const { nombre, descripcion } = req.body;

    const [result] = await db.query(
      `UPDATE categorias SET nombre = COALESCE(?, nombre), descripcion = ?
       WHERE id = ? AND organizacion_id = ?`,
      [nombre, descripcion || null, req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Categoría no encontrada' });
    }

    res.json({ mensaje: 'Categoría actualizada' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/categorias/:id
router.delete('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const [result] = await db.query(
      'UPDATE categorias SET activo = 0 WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Categoría no encontrada' });
    }

    res.json({ mensaje: 'Categoría eliminada' });
  } catch (error) {
    next(error);
  }
});

// GET /api/categorias/:id/subcategorias
router.get('/:id/subcategorias', auth, requireOrg, async (req, res, next) => {
  try {
    const [subcategorias] = await db.query(
      'SELECT * FROM subcategorias WHERE categoria_id = ? AND activo = 1 ORDER BY nombre',
      [req.params.id]
    );

    res.json({ subcategorias });
  } catch (error) {
    next(error);
  }
});

// POST /api/categorias/:id/subcategorias
router.post('/:id/subcategorias', auth, requireOrg, async (req, res, next) => {
  try {
    const { nombre } = req.body;

    if (!nombre) {
      return res.status(400).json({ error: 'Nombre es requerido' });
    }

    // Verificar que la categoría existe
    const [cats] = await db.query(
      'SELECT id FROM categorias WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (!cats.length) {
      return res.status(404).json({ error: 'Categoría no encontrada' });
    }

    const subcategoriaId = uuidv4();

    await db.query(
      `INSERT INTO subcategorias (id, categoria_id, nombre, creado_por) VALUES (?, ?, ?, ?)`,
      [subcategoriaId, req.params.id, nombre, req.usuario.id]
    );

    res.status(201).json({ id: subcategoriaId, subcategoria: { id: subcategoriaId, nombre } });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
