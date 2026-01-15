const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { auth, requireOrg } = require('../middlewares/auth.middleware');

// GET /api/plataformas
router.get('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { activo } = req.query;
    const [plataformas] = await db.query(
      `SELECT id, nombre, descripcion, activo, created_at, updated_at
       FROM plataformas 
       WHERE organizacion_id = ?
       ${activo !== undefined ? 'AND activo = ?' : ''} 
       ORDER BY nombre ASC`,
      activo !== undefined
        ? [req.organizacion.id, activo === 'true' || activo === '1']
        : [req.organizacion.id]
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

    // Obtener nombre actual (para compatibilidad si en transacciones se guarda como texto)
    const [[plataforma]] = await db.query(
      'SELECT id, nombre FROM plataformas WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    // Si hay transacciones asociadas:
    // - En algunos esquemas existe `transacciones.plataforma_id`
    // - En otros (compatibilidad) se guarda como texto en `transacciones.plataforma_origen`
    // Si no podemos validar por falta de columna, hacemos soft delete (activo=0) para no romper.
    let total = null;
    try {
      const [tx] = await db.query(
        'SELECT COUNT(*) as total FROM transacciones WHERE plataforma_id = ? AND organizacion_id = ?',
        [req.params.id, req.organizacion.id]
      );
      total = tx?.[0]?.total ?? 0;
    } catch (err) {
      if (err && err.code === 'ER_BAD_FIELD_ERROR') {
        try {
          const [tx2] = await db.query(
            'SELECT COUNT(*) as total FROM transacciones WHERE plataforma_origen = ? AND organizacion_id = ?',
            [plataforma?.nombre || '', req.organizacion.id]
          );
          total = tx2?.[0]?.total ?? 0;
        } catch (err2) {
          if (err2 && err2.code === 'ER_BAD_FIELD_ERROR') {
            total = null; // no podemos validar, pero no debemos fallar
          } else {
            throw err2;
          }
        }
      } else {
        throw err;
      }
    }

    // Si no se pudo validar, o sí hay uso, desactivar (soft delete)
    if (total === null || total > 0) {
      await db.query(
        'UPDATE plataformas SET activo = 0 WHERE id = ? AND organizacion_id = ?',
        [req.params.id, req.organizacion.id]
      );
      return res.json({ message: total > 0 ? 'Plataforma desactivada (tiene transacciones asociadas)' : 'Plataforma desactivada' });
    }

    // Sin uso: eliminar físicamente
    await db.query(
      'DELETE FROM plataformas WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );
    res.json({ message: 'Plataforma eliminada' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
