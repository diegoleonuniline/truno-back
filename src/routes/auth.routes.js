const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../config/database');
const { auth } = require('../middlewares/auth.middleware');

// Almacén temporal de challenges
const challenges = new Map();

// ========================================
// LOGIN TRADICIONAL
// ========================================

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { correo, contrasena } = req.body;

    if (!correo || !contrasena) {
      return res.status(400).json({ error: 'Correo y contraseña son requeridos' });
    }

    const [usuarios] = await db.query(
      'SELECT * FROM usuarios WHERE correo = ?',
      [correo]
    );

    if (!usuarios.length) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const usuario = usuarios[0];
    const valid = await bcrypt.compare(contrasena, usuario.contrasena);

    if (!valid) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign(
      { id: usuario.id, correo: usuario.correo },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      usuario: {
        id: usuario.id,
        nombre: usuario.nombre,
        apellido: usuario.apellido,
        correo: usuario.correo,
        rol: usuario.rol
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/register
router.post('/register', async (req, res, next) => {
  try {
    const { nombre, apellido, correo, contrasena } = req.body;

    if (!correo || !contrasena) {
      return res.status(400).json({ error: 'Correo y contraseña son requeridos' });
    }

    const [existing] = await db.query('SELECT id FROM usuarios WHERE correo = ?', [correo]);
    if (existing.length) {
      return res.status(400).json({ error: 'El correo ya está registrado' });
    }

    const hash = await bcrypt.hash(contrasena, 10);
    const id = uuidv4();

    await db.query(
      'INSERT INTO usuarios (id, nombre, apellido, correo, contrasena) VALUES (?, ?, ?, ?, ?)',
      [id, nombre, apellido, correo, hash]
    );

    const token = jwt.sign(
      { id, correo },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      token,
      usuario: { id, nombre, apellido, correo, rol: 'usuario' }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/me
router.get('/me', auth, async (req, res, next) => {
  try {
    const [usuarios] = await db.query(
      'SELECT id, nombre, apellido, correo, rol FROM usuarios WHERE id = ?',
      [req.usuario.id]
    );

    if (!usuarios.length) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({ usuario: usuarios[0] });
  } catch (error) {
    next(error);
  }
});

// ========================================
// PERFIL
// ========================================

// PUT /api/auth/perfil
router.put('/perfil', auth, async (req, res, next) => {
  try {
    const { nombre, apellido } = req.body;
    
    await db.query(
      'UPDATE usuarios SET nombre = ?, apellido = ? WHERE id = ?',
      [nombre, apellido, req.usuario.id]
    );

    res.json({ mensaje: 'Perfil actualizado' });
  } catch (error) {
    next(error);
  }
});

// PUT /api/auth/cambiar-password
router.put('/cambiar-password', auth, async (req, res, next) => {
  try {
    const { password_actual, password_nuevo } = req.body;

    if (!password_actual || !password_nuevo) {
      return res.status(400).json({ error: 'Ambas contraseñas son requeridas' });
    }

    const [usuarios] = await db.query('SELECT contrasena FROM usuarios WHERE id = ?', [req.usuario.id]);
    
    if (!usuarios.length) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const valid = await bcrypt.compare(password_actual, usuarios[0].contrasena);
    if (!valid) {
      return res.status(400).json({ error: 'Contraseña actual incorrecta' });
    }

    const hash = await bcrypt.hash(password_nuevo, 10);
    await db.query('UPDATE usuarios SET contrasena = ? WHERE id = ?', [hash, req.usuario.id]);

    res.json({ mensaje: 'Contraseña actualizada' });
  } catch (error) {
    next(error);
  }
});

// ========================================
// WEBAUTHN / BIOMETRÍA
// ========================================

// POST /api/auth/webauthn/register-options
router.post('/webauthn/register-options', auth, async (req, res, next) => {
  try {
    const challenge = crypto.randomBytes(32).toString('base64url');
    
    challenges.set(req.usuario.id, { challenge, expires: Date.now() + 300000 });

    // Dominio fijo para GitHub Pages
    const rpId = 'diegoleonuniline.github.io';

    const options = {
      challenge,
      rp: {
        name: 'TRUNO',
        id: rpId
      },
      user: {
        id: Buffer.from(req.usuario.id).toString('base64url'),
        name: req.usuario.correo,
        displayName: `${req.usuario.nombre || ''} ${req.usuario.apellido || ''}`.trim() || req.usuario.correo
      },
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },
        { alg: -257, type: 'public-key' }
      ],
      timeout: 60000,
      attestation: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred'
      }
    };

    console.log('📱 WebAuthn register options para:', req.usuario.correo);
    res.json(options);
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/webauthn/register
router.post('/webauthn/register', auth, async (req, res, next) => {
  try {
    const { credential, dispositivo } = req.body;
    
    if (!credential || !credential.id) {
      return res.status(400).json({ error: 'Credencial inválida' });
    }

    const stored = challenges.get(req.usuario.id);

    if (!stored || Date.now() > stored.expires) {
      return res.status(400).json({ error: 'Sesión expirada, intenta de nuevo' });
    }

    // Verificar si ya existe
    const [existing] = await db.query(
      'SELECT id FROM webauthn_credentials WHERE credential_id = ?',
      [credential.id]
    );

    if (existing.length) {
      return res.status(400).json({ error: 'Este dispositivo ya está registrado' });
    }

    // Guardar credencial
    await db.query(
      `INSERT INTO webauthn_credentials (id, usuario_id, credential_id, public_key, dispositivo)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), req.usuario.id, credential.id, JSON.stringify(credential), dispositivo || 'Dispositivo']
    );

    challenges.delete(req.usuario.id);

    console.log('✅ WebAuthn registrado para:', req.usuario.correo);
    res.json({ mensaje: 'Biometría registrada correctamente' });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/webauthn/credentials
router.get('/webauthn/credentials', auth, async (req, res, next) => {
  try {
    const [credentials] = await db.query(
      'SELECT id, dispositivo, created_at FROM webauthn_credentials WHERE usuario_id = ? ORDER BY created_at DESC',
      [req.usuario.id]
    );
    res.json({ credentials });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/auth/webauthn/credentials/:id
router.delete('/webauthn/credentials/:id', auth, async (req, res, next) => {
  try {
    const [result] = await db.query(
      'DELETE FROM webauthn_credentials WHERE id = ? AND usuario_id = ?',
      [req.params.id, req.usuario.id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Credencial no encontrada' });
    }

    res.json({ mensaje: 'Credencial eliminada' });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/webauthn/login-options
router.post('/webauthn/login-options', async (req, res, next) => {
  try {
    const { correo } = req.body;

    if (!correo) {
      return res.status(400).json({ error: 'Correo requerido' });
    }

    const [usuarios] = await db.query('SELECT id FROM usuarios WHERE correo = ?', [correo]);
    if (!usuarios.length) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const [credentials] = await db.query(
      'SELECT credential_id FROM webauthn_credentials WHERE usuario_id = ?',
      [usuarios[0].id]
    );

    if (!credentials.length) {
      return res.status(404).json({ error: 'No hay biometría configurada para este usuario' });
    }

    const challenge = crypto.randomBytes(32).toString('base64url');
    challenges.set(correo, { challenge, expires: Date.now() + 300000, usuarioId: usuarios[0].id });

    // Dominio fijo
    const rpId = 'diegoleonuniline.github.io';

    res.json({
      challenge,
      timeout: 60000,
      rpId,
      userVerification: 'required',
      allowCredentials: credentials.map(c => ({
        id: c.credential_id,
        type: 'public-key',
        transports: ['internal']
      }))
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/webauthn/login
router.post('/webauthn/login', async (req, res, next) => {
  try {
    const { correo, credential } = req.body;

    if (!correo || !credential) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }

    const stored = challenges.get(correo);

    if (!stored || Date.now() > stored.expires) {
      return res.status(400).json({ error: 'Sesión expirada' });
    }

    const [creds] = await db.query(
      `SELECT wc.*, u.id as usuario_id, u.nombre, u.apellido, u.correo, u.rol
       FROM webauthn_credentials wc
       JOIN usuarios u ON u.id = wc.usuario_id
       WHERE wc.credential_id = ? AND u.correo = ?`,
      [credential.id, correo]
    );

    if (!creds.length) {
      return res.status(401).json({ error: 'Credencial no válida' });
    }

    // Actualizar contador
    await db.query('UPDATE webauthn_credentials SET counter = counter + 1 WHERE credential_id = ?', [credential.id]);
    challenges.delete(correo);

    const token = jwt.sign(
      { id: creds[0].usuario_id, correo: creds[0].correo },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log('✅ WebAuthn login exitoso:', correo);

    res.json({
      token,
      usuario: {
        id: creds[0].usuario_id,
        nombre: creds[0].nombre,
        apellido: creds[0].apellido,
        correo: creds[0].correo,
        rol: creds[0].rol
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
