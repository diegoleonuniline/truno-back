const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth, requireOrg, requireRole } = require('../middlewares/auth.middleware');

// GET /api/organizaciones
router.get('/', auth, async (req, res, next) => {
  try {
    const [orgs] = await db.query(
      `SELECT o.*, uo.rol, uo.es_predeterminada,
              s.nombre_plan, s.modulos,
              (SELECT COUNT(*) FROM usuario_organizaciones WHERE organizacion_id = o.id) as total_miembros
       FROM usuario_organizaciones uo
       JOIN organizaciones o ON o.id = uo.organizacion_id
       LEFT JOIN suscripciones s ON s.organizacion_id = o.id AND s.activo = 1
       WHERE uo.usuario_id = ?
       ORDER BY uo.es_predeterminada DESC, o.nombre`,
      [req.usuario.id]
    );

    res.json(orgs.map(o => ({
      ...o,
      modulos: o.modulos ? JSON.parse(o.modulos) : ['bancos']
    })));
  } catch (error) {
    next(error);
  }
});

// POST /api/organizaciones
router.post('/', auth, [
  body('nombre').trim().notEmpty(),
  body('tipo').isIn(['persona_fisica', 'pyme'])
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { nombre, tipo, rfc, regimen_fiscal, nombre_legal, direccion, telefono, correo } = req.body;

    const orgId = uuidv4();

    await db.query(
      `INSERT INTO organizaciones (id, nombre, tipo, rfc, regimen_fiscal, nombre_legal, direccion, telefono, correo) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orgId, nombre, tipo, rfc || null, regimen_fiscal || null, nombre_legal || null, 
       direccion || null, telefono || null, correo || null]
    );

    await db.query(
      `INSERT INTO usuario_organizaciones (id, usuario_id, organizacion_id, rol, es_predeterminada) 
       VALUES (?, ?, ?, 'propietario', 0)`,
      [uuidv4(), req.usuario.id, orgId]
    );

    await db.query(
      `INSERT INTO suscripciones (id, organizacion_id, nombre_plan, modulos, max_usuarios, max_transacciones) 
       VALUES (?, ?, 'free', '["bancos"]', 1, 100)`,
      [uuidv4(), orgId]
    );

    res.status(201).json({ id: orgId, nombre, tipo });
  } catch (error) {
    next(error);
  }
});

// GET /api/organizaciones/:id
router.get('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const [orgs] = await db.query(
      `SELECT o.*, s.nombre_plan, s.modulos, s.max_usuarios, s.max_transacciones,
              (SELECT COUNT(*) FROM usuario_organizaciones WHERE organizacion_id = o.id) as total_miembros,
              (SELECT COUNT(*) FROM cuentas_bancarias WHERE organizacion_id = o.id AND activo = 1) as total_cuentas,
              (SELECT COUNT(*) FROM contactos WHERE organizacion_id = o.id AND activo = 1) as total_contactos
       FROM organizaciones o
       LEFT JOIN suscripciones s ON s.organizacion_id = o.id AND s.activo = 1
       WHERE o.id = ?`,
      [req.params.id]
    );

    if (!orgs.length) {
      return res.status(404).json({ error: 'Organización no encontrada' });
    }

    res.json({
      ...orgs[0],
      modulos: orgs[0].modulos ? JSON.parse(orgs[0].modulos) : ['bancos'],
      rol_usuario: req.organizacion.rol
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/organizaciones/:id
router.put('/:id', auth, requireOrg, requireRole('propietario', 'administrador'), async (req, res, next) => {
  try {
    const { nombre, rfc, regimen_fiscal, nombre_legal, direccion, telefono, correo, url_logo } = req.body;

    await db.query(
      `UPDATE organizaciones SET 
       nombre = COALESCE(?, nombre),
       rfc = COALESCE(?, rfc),
       regimen_fiscal = COALESCE(?, regimen_fiscal),
       nombre_legal = COALESCE(?, nombre_legal),
       direccion = COALESCE(?, direccion),
       telefono = COALESCE(?, telefono),
       correo = COALESCE(?, correo),
       url_logo = COALESCE(?, url_logo)
       WHERE id = ?`,
      [nombre, rfc, regimen_fiscal, nombre_legal, direccion, telefono, correo, url_logo, req.params.id]
    );

    res.json({ mensaje: 'Organización actualizada' });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/organizaciones/:id/estado
 * Dar de baja / reactivar una empresa.
 *
 * Requisito de negocio:
 * - “Vista donde pueda ver todas mis empresas, agregar, dar de baja, editar nombre”.
 *
 * Nota importante:
 * - Este endpoint asume que la tabla `organizaciones` tiene una columna `activo` (TINYINT/BOOLEAN).
 * - Si tu BD todavía no la tiene, regresamos 501 para no romper el servidor.
 */
router.put('/:id/estado', auth, requireOrg, requireRole('propietario', 'administrador'), async (req, res, next) => {
  try {
    const { activo } = req.body;
    if (activo === undefined) {
      return res.status(400).json({ error: 'Campo "activo" es requerido (true/false o 1/0)' });
    }

    try {
      const [result] = await db.query(
        'UPDATE organizaciones SET activo = ? WHERE id = ?',
        [activo === true || activo === 1 || activo === '1', req.params.id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Organización no encontrada' });
      }

      res.json({ mensaje: (activo === true || activo === 1 || activo === '1') ? 'Organización reactivada' : 'Organización dada de baja' });
    } catch (err) {
      // Compatibilidad con BD sin columna `activo`
      if (err && err.code === 'ER_BAD_FIELD_ERROR') {
        return res.status(501).json({
          error: 'Tu base de datos no soporta dar de baja organizaciones (falta columna organizaciones.activo)'
        });
      }
      throw err;
    }
  } catch (error) {
    next(error);
  }
});

// GET /api/organizaciones/:id/miembros
router.get('/:id/miembros', auth, requireOrg, async (req, res, next) => {
  try {
    const [miembros] = await db.query(
      `SELECT u.id, u.correo, u.nombre, u.apellido, u.ultimo_acceso,
              uo.rol, uo.fecha_union,
              inv.nombre as invitado_por_nombre
       FROM usuario_organizaciones uo
       JOIN usuarios u ON u.id = uo.usuario_id
       LEFT JOIN usuarios inv ON inv.id = uo.invitado_por
       WHERE uo.organizacion_id = ?
       ORDER BY uo.rol, u.nombre`,
      [req.params.id]
    );

    res.json(miembros);
  } catch (error) {
    next(error);
  }
});

// POST /api/organizaciones/:id/invitar
router.post('/:id/invitar', auth, requireOrg, requireRole('propietario', 'administrador'), [
  body('correo').isEmail(),
  body('rol').isIn(['administrador', 'usuario', 'visualizador'])
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { correo, rol } = req.body;

    const [usuarios] = await db.query('SELECT id FROM usuarios WHERE correo = ?', [correo]);
    
    if (!usuarios.length) {
      return res.status(404).json({ error: 'Usuario no encontrado. Debe registrarse primero.' });
    }

    const [existing] = await db.query(
      'SELECT id FROM usuario_organizaciones WHERE usuario_id = ? AND organizacion_id = ?',
      [usuarios[0].id, req.params.id]
    );

    if (existing.length) {
      return res.status(400).json({ error: 'Usuario ya es miembro' });
    }

    await db.query(
      `INSERT INTO usuario_organizaciones (id, usuario_id, organizacion_id, rol, invitado_por) 
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), usuarios[0].id, req.params.id, rol, req.usuario.id]
    );

    res.status(201).json({ mensaje: 'Invitación enviada' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/organizaciones/:id/miembros/:usuarioId
router.delete('/:id/miembros/:usuarioId', auth, requireOrg, requireRole('propietario', 'administrador'), async (req, res, next) => {
  try {
    if (req.params.usuarioId === req.usuario.id) {
      return res.status(400).json({ error: 'No puedes removerte a ti mismo' });
    }

    const [miembro] = await db.query(
      'SELECT rol FROM usuario_organizaciones WHERE usuario_id = ? AND organizacion_id = ?',
      [req.params.usuarioId, req.params.id]
    );

    if (!miembro.length) {
      return res.status(404).json({ error: 'Miembro no encontrado' });
    }

    if (miembro[0].rol === 'propietario') {
      return res.status(400).json({ error: 'No se puede remover al propietario' });
    }

    await db.query(
      'DELETE FROM usuario_organizaciones WHERE usuario_id = ? AND organizacion_id = ?',
      [req.params.usuarioId, req.params.id]
    );

    res.json({ mensaje: 'Miembro removido' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
