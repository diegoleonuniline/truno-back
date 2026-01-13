/**
 * TRUNO - Rutas de Plataformas
 * CRUD completo para plataformas de pago
 */
const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verificarToken } = require('../middlewares/auth');
const { v4: uuidv4 } = require('uuid');

// Aplicar middleware de autenticación a todas las rutas
router.use(verificarToken);

/**
 * GET /api/plataformas
 * Obtener todas las plataformas de la organización
 */
router.get('/', async (req, res) => {
  try {
    const orgId = req.organizacionId;
    
    const [plataformas] = await db.query(
      `SELECT id, nombre, descripcion, activo, created_at, updated_at
       FROM plataformas 
       WHERE organizacion_id = ? 
       ORDER BY nombre ASC`,
      [orgId]
    );
    
    res.json({ plataformas });
  } catch (error) {
    console.error('Error al obtener plataformas:', error);
    res.status(500).json({ error: 'Error al obtener plataformas' });
  }
});

/**
 * GET /api/plataformas/:id
 * Obtener una plataforma por ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.organizacionId;
    
    const [plataformas] = await db.query(
      `SELECT id, nombre, descripcion, activo, created_at, updated_at
       FROM plataformas 
       WHERE id = ? AND organizacion_id = ?`,
      [id, orgId]
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

/**
 * POST /api/plataformas
 * Crear nueva plataforma
 */
router.post('/', async (req, res) => {
  try {
    const orgId = req.organizacionId;
    const { nombre, descripcion } = req.body;
    
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ error: 'El nombre es requerido' });
    }
    
    // Verificar duplicado
    const [existe] = await db.query(
      'SELECT id FROM plataformas WHERE organizacion_id = ? AND nombre = ?',
      [orgId, nombre.trim()]
    );
    
    if (existe.length > 0) {
      return res.status(400).json({ error: 'Ya existe una plataforma con ese nombre' });
    }
    
    const id = uuidv4();
    
    await db.query(
      `INSERT INTO plataformas (id, organizacion_id, nombre, descripcion, activo)
       VALUES (?, ?, ?, ?, 1)`,
      [id, orgId, nombre.trim(), descripcion?.trim() || null]
    );
    
    const [nueva] = await db.query(
      'SELECT * FROM plataformas WHERE id = ?',
      [id]
    );
    
    res.status(201).json({ plataforma: nueva[0] });
  } catch (error) {
    console.error('Error al crear plataforma:', error);
    res.status(500).json({ error: 'Error al crear plataforma' });
  }
});

/**
 * PUT /api/plataformas/:id
 * Actualizar plataforma
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.organizacionId;
    const { nombre, descripcion, activo } = req.body;
    
    // Verificar que existe
    const [existe] = await db.query(
      'SELECT id FROM plataformas WHERE id = ? AND organizacion_id = ?',
      [id, orgId]
    );
    
    if (existe.length === 0) {
      return res.status(404).json({ error: 'Plataforma no encontrada' });
    }
    
    // Verificar duplicado de nombre
    if (nombre) {
      const [duplicado] = await db.query(
        'SELECT id FROM plataformas WHERE organizacion_id = ? AND nombre = ? AND id != ?',
        [orgId, nombre.trim(), id]
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
      [nombre?.trim(), descripcion?.trim(), activo, id, orgId]
    );
    
    const [actualizada] = await db.query(
      'SELECT * FROM plataformas WHERE id = ?',
      [id]
    );
    
    res.json({ plataforma: actualizada[0] });
  } catch (error) {
    console.error('Error al actualizar plataforma:', error);
    res.status(500).json({ error: 'Error al actualizar plataforma' });
  }
});

/**
 * DELETE /api/plataformas/:id
 * Eliminar plataforma (soft delete)
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.organizacionId;
    
    // Verificar que existe
    const [existe] = await db.query(
      'SELECT id FROM plataformas WHERE id = ? AND organizacion_id = ?',
      [id, orgId]
    );
    
    if (existe.length === 0) {
      return res.status(404).json({ error: 'Plataforma no encontrada' });
    }
    
    // Verificar si tiene transacciones asociadas
    const [transacciones] = await db.query(
      'SELECT COUNT(*) as total FROM transacciones WHERE plataforma_id = ?',
      [id]
    );
    
    if (transacciones[0].total > 0) {
      // Soft delete - solo desactivar
      await db.query(
        'UPDATE plataformas SET activo = 0 WHERE id = ?',
        [id]
      );
      return res.json({ message: 'Plataforma desactivada (tiene transacciones asociadas)' });
    }
    
    // Hard delete si no tiene transacciones
    await db.query(
      'DELETE FROM plataformas WHERE id = ? AND organizacion_id = ?',
      [id, orgId]
    );
    
    res.json({ message: 'Plataforma eliminada' });
  } catch (error) {
    console.error('Error al eliminar plataforma:', error);
    res.status(500).json({ error: 'Error al eliminar plataforma' });
  }
});

module.exports = router;
