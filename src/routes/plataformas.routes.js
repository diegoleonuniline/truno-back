const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { auth, requireOrg } = require('../middlewares/auth.middleware');

// GET /api/plataformas
router.get('/', auth, requireOrg, async (req, res, next) => {
  try {
    const [plataformas] = await db.query(
      `SELECT id, nombre, descripcion, activo, created_at, updated_at
       FROM plataformas 
       WHERE organizacion_id = ? 
       ORDER BY nombre ASC`,
      [req.organizacion.id]
    );
    res.json({ plataformas });
  } catch (error) {
    next(error);
  }
});

// GET /api/plataformas/:id
router.get('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const [plataformas] = await db.query(
      `SELECT id, nombre, descripcion, activo, created_at, updated_at
       FROM plataformas 
       WHERE id = ? AND organizacion_id = ?`,
      [req.params.id, req.organizacion.id]
    );
    if (!plataformas.length) {
      return res.status(404).json({ error: 'Plataforma no encontrada' });
    }
    res.json({ plataforma: plataformas[0] });
  } catch (error) {
    next(error);
  }
});

// POST /api/plataformas
router.post('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { nombre, descripcion } = req.body;
    
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ error: 'El nombre es requerido' });
    }
    
    const [existe] = await db.query(
      'SELECT id FROM plataformas WHERE organizacion_id = ? AND nombre = ?',
      [req.organizacion.id, nombre.trim()]
    );
    
    if (existe.length > 0) {
      return res.status(400).json({ error: 'Ya existe una plataforma con ese nombre' });
    }
    
    const id = uuidv4();
    
    await db.query(
      `INSERT INTO plataformas (id, organizacion_id, nombre, descripcion, activo)
       VALUES (?, ?, ?, ?, 1)`,
      [id, req.organizacion.id, nombre.trim(), descripcion?.trim() || null]
    );
    
    const [nueva] = await db.query('SELECT * FROM plataformas WHERE id = ?', [id]);
    res.status(201).json({ plataforma: nueva[0] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/plataformas/:id
router.put('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const { nombre, descripcion, activo } = req.body;
    
    const [existe] = await db.query(
      'SELECT id FROM plataformas WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );
    
    if (!existe.length) {
      return res.status(404).json({ error: 'Plataforma no encontrada' });
    }
    
    if (nombre) {
      const [duplicado] = await db.query(
        'SELECT id FROM plataformas WHERE organizacion_id = ? AND nombre = ? AND id != ?',
        [req.organizacion.id, nombre.trim(), req.params.id]
      );
      if (duplicado.length > 0) {
        return res.status(400).json({ error: 'Ya existe una plataforma con ese nombre' });
      }
    }
    
    await db.query(
      `UPDATE plataformas SET
        nombre = COALESCE(?, nombre),
        descripcion = COALESCE(?, descripcion),
        activo = COALESCE(?, activo)
       WHERE id = ? AND organizacion_id = ?`,
      [nombre?.trim(), descripcion?.trim(), activo, req.params.id, req.organizacion.id]
    );
    
    const [actualizada] = await db.query('SELECT * FROM plataformas WHERE id = ?', [req.params.id]);
    res.json({ plataforma: actualizada[0] });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/plataformas/:id
router.delete('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const [existe] = await db.query(
      'SELECT id FROM plataformas WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );
    
    if (!existe.length) {
      return res.status(404).json({ error: 'Plataforma no encontrada' });
    }
    
    const [transacciones] = await db.query(
      'SELECT COUNT(*) as total FROM transacciones WHERE plataforma_id = ?',
      [req.params.id]
    );
    
    if (transacciones[0].total > 0) {
      await db.query('UPDATE plataformas SET activo = 0 WHERE id = ?', [req.params.id]);
      return res.json({ message: 'Plataforma desactivada (tiene transacciones asociadas)' });
    }
    
    await db.query('DELETE FROM plataformas WHERE id = ? AND organizacion_id = ?', [req.params.id, req.organizacion.id]);
    res.json({ message: 'Plataforma eliminada' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
