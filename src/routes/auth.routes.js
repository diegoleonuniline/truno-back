const crypto = require('crypto');

// Almacén temporal de challenges (en producción usar Redis)
const challenges = new Map();

// POST /api/auth/webauthn/register-options
router.post('/webauthn/register-options', auth, async (req, res) => {
  try {
    const challenge = crypto.randomBytes(32).toString('base64url');
    
    // Guardar challenge temporalmente (5 min)
    challenges.set(req.usuario.id, { challenge, expires: Date.now() + 300000 });

    const options = {
      challenge,
      rp: {
        name: 'TRUNO',
        id: 'diegoleonuniline.github.io' // Tu dominio
      },
      user: {
        id: Buffer.from(req.usuario.id).toString('base64url'),
        name: req.usuario.correo,
        displayName: `${req.usuario.nombre} ${req.usuario.apellido || ''}`
      },
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },   // ES256
        { alg: -257, type: 'public-key' }  // RS256
      ],
      timeout: 60000,
      attestation: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform', // Face ID, Touch ID
        userVerification: 'required',
        residentKey: 'preferred'
      }
    };

    res.json(options);
  } catch (error) {
    console.error('WebAuthn register options error:', error);
    res.status(500).json({ error: 'Error generando opciones' });
  }
});

// POST /api/auth/webauthn/register
router.post('/webauthn/register', auth, async (req, res) => {
  try {
    const { credential } = req.body;
    const stored = challenges.get(req.usuario.id);

    if (!stored || Date.now() > stored.expires) {
      return res.status(400).json({ error: 'Challenge expirado' });
    }

    // Guardar credencial en BD
    await db.query(
      `INSERT INTO webauthn_credentials (id, usuario_id, credential_id, public_key, counter, created_at)
       VALUES (UUID(), ?, ?, ?, 0, NOW())`,
      [req.usuario.id, credential.id, JSON.stringify(credential)]
    );

    challenges.delete(req.usuario.id);

    res.json({ mensaje: 'Biometría registrada correctamente' });
  } catch (error) {
    console.error('WebAuthn register error:', error);
    res.status(500).json({ error: 'Error registrando credencial' });
  }
});

// POST /api/auth/webauthn/login-options
router.post('/webauthn/login-options', async (req, res) => {
  try {
    const { correo } = req.body;

    // Buscar usuario y sus credenciales
    const [usuarios] = await db.query(
      'SELECT id FROM usuarios WHERE correo = ?',
      [correo]
    );

    if (!usuarios.length) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const [credentials] = await db.query(
      'SELECT credential_id FROM webauthn_credentials WHERE usuario_id = ?',
      [usuarios[0].id]
    );

    if (!credentials.length) {
      return res.status(404).json({ error: 'No hay biometría configurada' });
    }

    const challenge = crypto.randomBytes(32).toString('base64url');
    challenges.set(correo, { challenge, expires: Date.now() + 300000 });

    const options = {
      challenge,
      timeout: 60000,
      rpId: 'diegoleonuniline.github.io',
      userVerification: 'required',
      allowCredentials: credentials.map(c => ({
        id: c.credential_id,
        type: 'public-key',
        transports: ['internal']
      }))
    };

    res.json(options);
  } catch (error) {
    console.error('WebAuthn login options error:', error);
    res.status(500).json({ error: 'Error generando opciones' });
  }
});

// POST /api/auth/webauthn/login
router.post('/webauthn/login', async (req, res) => {
  try {
    const { correo, credential } = req.body;
    const stored = challenges.get(correo);

    if (!stored || Date.now() > stored.expires) {
      return res.status(400).json({ error: 'Challenge expirado' });
    }

    // Buscar credencial
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
    await db.query(
      'UPDATE webauthn_credentials SET counter = counter + 1 WHERE credential_id = ?',
      [credential.id]
    );

    challenges.delete(correo);

    // Generar token
    const token = jwt.sign(
      { id: creds[0].usuario_id, correo: creds[0].correo },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

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
    console.error('WebAuthn login error:', error);
    res.status(500).json({ error: 'Error de autenticación' });
  }
});
