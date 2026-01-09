const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { auth, requireOrg } = require('../middlewares/auth.middleware');

// GET /api/monedas
router.get('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { activo } = req.query;
    
    let sql = 'SELECT * FROM monedas WHERE organizacion_id = ?';
    const params = [req.organizacion.id];

    if (activo !== undefined) {
      sql += ' AND activo = ?';
      params.push(activo === 'true' || activo === '1');
    }

    sql += ' ORDER BY es_default DESC, codigo';
    const [monedas] = await db.query(sql, params);

    res.json({ monedas });
  } catch (error) {
    next(error);
  }
});

// GET /api/monedas/:id
router.get('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM monedas WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Moneda no encontrada' });
    }

    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

// POST /api/monedas
router.post('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { codigo, nombre, simbolo = '$', decimales = 2, es_default = false, activo = true } = req.body;

    if (!codigo || !nombre) {
      return res.status(400).json({ error: 'Código y nombre son requeridos' });
    }

    // Si es default, quitar default de las demás
    if (es_default) {
      await db.query(
        'UPDATE monedas SET es_default = FALSE WHERE organizacion_id = ?',
        [req.organizacion.id]
      );
    }

    const id = uuidv4();
    await db.query(
      `INSERT INTO monedas (id, organizacion_id, codigo, nombre, simbolo, decimales, es_default, activo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.organizacion.id, codigo.toUpperCase(), nombre, simbolo, decimales, es_default, activo]
    );

    res.status(201).json({ 
      id, 
      moneda: { id, codigo: codigo.toUpperCase(), nombre, simbolo, decimales, es_default, activo }, 
      mensaje: 'Moneda creada' 
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Ya existe una moneda con ese código' });
    }
    next(error);
  }
});

// PUT /api/monedas/:id
router.put('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const { codigo, nombre, simbolo, decimales, es_default, activo } = req.body;

    // Si es default, quitar default de las demás
    if (es_default) {
      await db.query(
        'UPDATE monedas SET es_default = FALSE WHERE organizacion_id = ? AND id != ?',
        [req.organizacion.id, req.params.id]
      );
    }

    const [result] = await db.query(
      `UPDATE monedas SET
       codigo = COALESCE(?, codigo),
       nombre = COALESCE(?, nombre),
       simbolo = COALESCE(?, simbolo),
       decimales = COALESCE(?, decimales),
       es_default = COALESCE(?, es_default),
       activo = COALESCE(?, activo)
       WHERE id = ? AND organizacion_id = ?`,
      [codigo?.toUpperCase(), nombre, simbolo, decimales, es_default, activo, req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Moneda no encontrada' });
    }

    res.json({ mensaje: 'Moneda actualizada' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Ya existe una moneda con ese código' });
    }
    next(error);
  }
});

// DELETE /api/monedas/:id
router.delete('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    // No permitir eliminar moneda default
    const [moneda] = await db.query(
      'SELECT es_default FROM monedas WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (moneda.length && moneda[0].es_default) {
      return res.status(400).json({ error: 'No puedes eliminar la moneda por defecto' });
    }

    const [result] = await db.query(
      'DELETE FROM monedas WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Moneda no encontrada' });
    }

    res.json({ mensaje: 'Moneda eliminada' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
