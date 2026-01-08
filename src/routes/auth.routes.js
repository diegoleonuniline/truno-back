const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth } = require('../middlewares/auth.middleware');

// POST /api/auth/register
router.post('/register', [
  body('correo').isEmail().normalizeEmail(),
  body('contrasena').isLength({ min: 8 }),
  body('nombre').trim().notEmpty(),
  body('apellido').trim().notEmpty()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { correo, contrasena, nombre, apellido, telefono } = req.body;

    const [existing] = await db.query('SELECT id FROM usuarios WHERE correo = ?', [correo]);
    if (existing.length) {
      return res.status(400).json({ error: 'El correo ya está registrado' });
    }

    const usuarioId = uuidv4();
    const contrasenaHash = await bcrypt.hash(contrasena, 12);

    await db.query(
      `INSERT INTO usuarios (id, correo, contrasena_hash, nombre, apellido, telefono) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [usuarioId, correo, contrasenaHash, nombre, apellido, telefono || null]
    );

    const orgId = uuidv4();
    await db.query(
      `INSERT INTO organizaciones (id, nombre, tipo) VALUES (?, ?, 'persona_fisica')`,
      [orgId, `${nombre} ${apellido}`]
    );

    await db.query(
      `INSERT INTO usuario_organizaciones (id, usuario_id, organizacion_id, rol, es_predeterminada) 
       VALUES (?, ?, ?, 'propietario', 1)`,
      [uuidv4(), usuarioId, orgId]
    );

    await db.query(
      `INSERT INTO suscripciones (id, organizacion_id, nombre_plan, modulos, max_usuarios, max_transacciones) 
       VALUES (?, ?, 'free', '["bancos"]', 1, 100)`,
      [uuidv4(), orgId]
    );

    const token = jwt.sign({ odersId: usuarioId }, process.env.JWT_SECRET, { 
      expiresIn: process.env.JWT_EXPIRES_IN 
    });

    res.status(201).json({
      mensaje: 'Usuario registrado exitosamente',
      token,
      usuario: { id: usuarioId, correo, nombre, apellido }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/login
router.post('/login', [
  body('correo').isEmail().normalizeEmail(),
  body('contrasena').notEmpty()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { correo, contrasena } = req.body;

    const [usuarios] = await db.query(
      'SELECT * FROM usuarios WHERE correo = ?',
      [correo]
    );

    if (!usuarios.length) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const usuario = usuarios[0];

    if (!usuario.activo) {
      return res.status(401).json({ error: 'Cuenta desactivada' });
    }

    const contrasenaValida = await bcrypt.compare(contrasena, usuario.contrasena_hash);
    if (!contrasenaValida) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    await db.query('UPDATE usuarios SET ultimo_acceso = NOW() WHERE id = ?', [usuario.id]);

    const token = jwt.sign({ usuarioId: usuario.id }, process.env.JWT_SECRET, { 
      expiresIn: process.env.JWT_EXPIRES_IN 
    });

    res.json({
      token,
      usuario: {
        id: usuario.id,
        correo: usuario.correo,
        nombre: usuario.nombre,
        apellido: usuario.apellido
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/me
router.get('/me', auth, async (req, res, next) => {
  try {
    const [orgs] = await db.query(
      `SELECT o.*, uo.rol, uo.es_predeterminada,
              s.nombre_plan, s.modulos
       FROM usuario_organizaciones uo
       JOIN organizaciones o ON o.id = uo.organizacion_id
       LEFT JOIN suscripciones s ON s.organizacion_id = o.id AND s.activo = 1
       WHERE uo.usuario_id = ?
       ORDER BY uo.es_predeterminada DESC, o.nombre`,
      [req.usuario.id]
    );

    res.json({
      usuario: req.usuario,
      organizaciones: orgs.map(o => ({
        id: o.id,
        nombre: o.nombre,
        tipo: o.tipo,
        rol: o.rol,
        es_predeterminada: o.es_predeterminada,
        activo: o.activo,
        plan: o.nombre_plan || 'free',
        modulos: o.modulos ? JSON.parse(o.modulos) : ['bancos']
      }))
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/cambiar-contrasena
router.post('/cambiar-contrasena', auth, [
  body('contrasena_actual').notEmpty(),
  body('contrasena_nueva').isLength({ min: 8 })
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { contrasena_actual, contrasena_nueva } = req.body;

    const [usuarios] = await db.query(
      'SELECT contrasena_hash FROM usuarios WHERE id = ?',
      [req.usuario.id]
    );

    const valida = await bcrypt.compare(contrasena_actual, usuarios[0].contrasena_hash);
    if (!valida) {
      return res.status(400).json({ error: 'Contraseña actual incorrecta' });
    }

    const nuevoHash = await bcrypt.hash(contrasena_nueva, 12);
    await db.query('UPDATE usuarios SET contrasena_hash = ? WHERE id = ?', [nuevoHash, req.usuario.id]);

    res.json({ mensaje: 'Contraseña actualizada' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
