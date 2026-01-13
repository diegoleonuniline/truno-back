/**
 * TRUNO - Rutas de Plataformas
 * CRUD completo para plataformas de pago
 */
const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { auth, requireOrg } = require('../middlewares/auth.middleware');
const { v4: uuidv4 } = require('uuid');

// GET /api/plataformas
router.get('/', auth, requireOrg, async (req, res) => {
  try {
    const [plataformas] = await db.query(
      `SELECT id, nombre, descripcion, activo, created_at, updated_at
       FROM plataformas 
       WHERE organizacion_id = ? 
       ORDER BY nombre ASC`,
      [req.organization.id]
    );
    res.json({ plataformas });
  } catch (error) {
    console.error('Error al obtener plataformas:', error);
    res.status(500).json({ error: 'Error al obtener plataformas' });
  }
});

// GET /api/plataformas/:id
router.get('/:id', auth, requireOrg, async (req, res) => {
  try {
    const [plataformas] = await db.query(
      `SELECT id, nombre, descripcion, activo, created_at, updated_at
       FROM plataformas 
       WHERE id = ? AND organizacion_id = ?`,
      [req.params.id, req.organization.id]
    );
    if (plataformas.length === 0) {
      return res.status(404).json({ error: 'Plataforma no encontrada' });
    }
    res.json({ plataforma: plataformas[0] });
  } catch (error) {
    console.error('Error al obtener plataforma:', error);
    res.status(500).json({ error: 'Error al obtener plataforma' });
  }
});

// POST /api/plataformas
router.post('/', auth, requireOrg, async (req, res) => {
  try {
    const { nombre, descripcion } = req.body;
    
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ error: 'El nombre es requerido' });
    }
    
    const [existe] = await db.query(
      'SELECT id FROM plataformas WHERE organizacion_id = ? AND nombre = ?',
      [req.organization.id, nombre.trim()]
    );
    
    if (existe.length > 0) {
      return res.status(400).json({ error: 'Ya existe una plataforma con ese nombre' });
    }
    
    const id = uuidv4();
    
    await db.query(
      `INSERT INTO plataformas (id, organizacion_id, nombre, descripcion, activo)
       VALUES (?, ?, ?, ?, 1)`,
      [id, req.organization.id, nombre.trim(), descripcion?.trim() || null]
    );
    
    const [nueva] = await db.query('SELECT * FROM plataformas WHERE id = ?', [id]);
    res.status(201).json({ plataforma: nueva[0] });
  } catch (error) {
    console.error('Error al crear plataforma:', error);
    res.status(500).json({ error: 'Error al crear plataforma' });
  }
});

// PUT /api/plataformas/:id
router.put('/:id', auth, requireOrg, async (req, res) => {
  try {
    const { nombre, descripcion, activo } = req.body;
    
    const [existe] = await db.query(
      'SELECT id FROM plataformas WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organization.id]
    );
    
    if (existe.length === 0) {
      return res.status(404).json({ error: 'Plataforma no encontrada' });
    }
    
    if (nombre) {
      const [duplicado] = await db.query(
        'SELECT id FROM plataformas WHERE organizacion_id = ? AND nombre = ? AND id != ?',
        [req.organization.id, nombre.trim(), req.params.id]
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
      [nombre?.trim(), descripcion?.trim(), activo, req.params.id, req.organization.id]
    );
    
    const [actualizada] = await db.query('SELECT * FROM plataformas WHERE id = ?', [req.params.id]);
    res.json({ plataforma: actualizada[0] });
  } catch (error) {
    console.error('Error al actualizar plataforma:', error);
    res.status(500).json({ error: 'Error al actualizar plataforma' });
  }
});

// DELETE /api/plataformas/:id
router.delete('/:id', auth, requireOrg, async (req, res) => {
  try {
    const [existe] = await db.query(
      'SELECT id FROM plataformas WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organization.id]
    );
    
    if (existe.length === 0) {
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
    
    await db.query('DELETE FROM plataformas WHERE id = ? AND organizacion_id = ?', [req.params.id, req.organization.id]);
    res.json({ message: 'Plataforma eliminada' });
  } catch (error) {
    console.error('Error al eliminar plataforma:', error);
    res.status(500).json({ error: 'Error al eliminar plataforma' });
  }
});

module.exports = router;
