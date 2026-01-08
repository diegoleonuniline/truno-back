const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { auth, requireOrg } = require('../middlewares/auth.middleware');

// GET /api/impuestos
router.get('/', auth, requireOrg, async (req, res, next) => {
  try {
    const [impuestos] = await db.query(
      `SELECT * FROM impuestos WHERE organizacion_id = ? AND activo = 1 ORDER BY tipo, nombre`,
      [req.organizacion.id]
    );
    res.json({ impuestos });
  } catch (error) {
    next(error);
  }
});

// GET /api/impuestos/:id
router.get('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const [impuestos] = await db.query(
      'SELECT * FROM impuestos WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );
    if (!impuestos.length) {
      return res.status(404).json({ error: 'Impuesto no encontrado' });
    }
    res.json(impuestos[0]);
  } catch (error) {
    next(error);
  }
});

// POST /api/impuestos
router.post('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { nombre, clave_sat, tipo, tasa } = req.body;

    if (!nombre || !tipo || tasa === undefined) {
      return res.status(400).json({ error: 'Nombre, tipo y tasa son requeridos' });
    }

    const id = uuidv4();
    await db.query(
      `INSERT INTO impuestos (id, organizacion_id, nombre, clave_sat, tipo, tasa)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, req.organizacion.id, nombre, clave_sat || null, tipo, parseFloat(tasa)]
    );

    res.status(201).json({ id, mensaje: 'Impuesto creado' });
  } catch (error) {
    next(error);
  }
});

// PUT /api/impuestos/:id
router.put('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const { nombre, clave_sat, tipo, tasa, activo } = req.body;

    const [result] = await db.query(
      `UPDATE impuestos SET 
       nombre = COALESCE(?, nombre),
       clave_sat = ?,
       tipo = COALESCE(?, tipo),
       tasa = COALESCE(?, tasa),
       activo = COALESCE(?, activo)
       WHERE id = ? AND organizacion_id = ?`,
      [nombre, clave_sat, tipo, tasa, activo, req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Impuesto no encontrado' });
    }

    res.json({ mensaje: 'Impuesto actualizado' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/impuestos/:id (soft delete)
router.delete('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const [result] = await db.query(
      'UPDATE impuestos SET activo = 0 WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Impuesto no encontrado' });
    }

    res.json({ mensaje: 'Impuesto eliminado' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
