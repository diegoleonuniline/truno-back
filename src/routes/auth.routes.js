const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth } = require('../middlewares/auth.middleware');

// POST /api/auth/register
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('first_name').trim().notEmpty(),
  body('last_name').trim().notEmpty()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, first_name, last_name, phone } = req.body;

    // Verificar email existente
    const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length) {
      return res.status(400).json({ error: 'Email ya registrado' });
    }

    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(password, 12);

    await db.query(
      `INSERT INTO users (id, email, password_hash, first_name, last_name, phone) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, email, passwordHash, first_name, last_name, phone || null]
    );

    // Crear organización personal por defecto
    const orgId = uuidv4();
    await db.query(
      `INSERT INTO organizations (id, name, type) VALUES (?, ?, 'persona_fisica')`,
      [orgId, `${first_name} ${last_name}`]
    );

    await db.query(
      `INSERT INTO user_organizations (id, user_id, organization_id, role, is_default) 
       VALUES (?, ?, ?, 'owner', 1)`,
      [uuidv4(), userId, orgId]
    );

    // Crear suscripción free
    await db.query(
      `INSERT INTO subscriptions (id, organization_id, plan_name, modules, max_users, max_transactions) 
       VALUES (?, ?, 'free', '["bancos"]', 1, 100)`,
      [uuidv4(), orgId]
    );

    const token = jwt.sign({ userId }, process.env.JWT_SECRET, { 
      expiresIn: process.env.JWT_EXPIRES_IN 
    });

    res.status(201).json({
      message: 'Usuario registrado exitosamente',
      token,
      user: { id: userId, email, first_name, last_name }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    const [users] = await db.query(
      'SELECT * FROM users WHERE email = ?',
      [email]
    );

    if (!users.length) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const user = users[0];

    if (!user.is_active) {
      return res.status(401).json({ error: 'Cuenta desactivada' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Actualizar último login
    await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { 
      expiresIn: process.env.JWT_EXPIRES_IN 
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name
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
      `SELECT o.*, uo.role, uo.is_default,
              s.plan_name, s.modules
       FROM user_organizations uo
       JOIN organizations o ON o.id = uo.organization_id
       LEFT JOIN subscriptions s ON s.organization_id = o.id AND s.is_active = 1
       WHERE uo.user_id = ?
       ORDER BY uo.is_default DESC, o.name`,
      [req.user.id]
    );

    res.json({
      user: req.user,
      organizations: orgs.map(o => ({
        id: o.id,
        name: o.name,
        type: o.type,
        role: o.role,
        is_default: o.is_default,
        is_active: o.is_active,
        plan: o.plan_name || 'free',
        modules: o.modules ? JSON.parse(o.modules) : ['bancos']
      }))
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/change-password
router.post('/change-password', auth, [
  body('current_password').notEmpty(),
  body('new_password').isLength({ min: 8 })
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { current_password, new_password } = req.body;

    const [users] = await db.query(
      'SELECT password_hash FROM users WHERE id = ?',
      [req.user.id]
    );

    const valid = await bcrypt.compare(current_password, users[0].password_hash);
    if (!valid) {
      return res.status(400).json({ error: 'Contraseña actual incorrecta' });
    }

    const newHash = await bcrypt.hash(new_password, 12);
    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.user.id]);

    res.json({ message: 'Contraseña actualizada' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
