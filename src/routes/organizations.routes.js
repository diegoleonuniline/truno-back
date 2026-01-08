const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth, requireOrg, requireRole } = require('../middlewares/auth.middleware');

// GET /api/organizations - Listar mis organizaciones
router.get('/', auth, async (req, res, next) => {
  try {
    const [orgs] = await db.query(
      `SELECT o.*, uo.role, uo.is_default,
              s.plan_name, s.modules,
              (SELECT COUNT(*) FROM user_organizations WHERE organization_id = o.id) as member_count
       FROM user_organizations uo
       JOIN organizations o ON o.id = uo.organization_id
       LEFT JOIN subscriptions s ON s.organization_id = o.id AND s.is_active = 1
       WHERE uo.user_id = ?
       ORDER BY uo.is_default DESC, o.name`,
      [req.user.id]
    );

    res.json(orgs.map(o => ({
      ...o,
      modules: o.modules ? JSON.parse(o.modules) : ['bancos']
    })));
  } catch (error) {
    next(error);
  }
});

// POST /api/organizations - Crear organización
router.post('/', auth, [
  body('name').trim().notEmpty(),
  body('type').isIn(['persona_fisica', 'pyme'])
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, type, rfc, tax_regime, legal_name, address, phone, email } = req.body;

    const orgId = uuidv4();

    await db.query(
      `INSERT INTO organizations (id, name, type, rfc, tax_regime, legal_name, address, phone, email) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orgId, name, type, rfc || null, tax_regime || null, legal_name || null, 
       address || null, phone || null, email || null]
    );

    // Asociar usuario como owner
    await db.query(
      `INSERT INTO user_organizations (id, user_id, organization_id, role, is_default) 
       VALUES (?, ?, ?, 'owner', 0)`,
      [uuidv4(), req.user.id, orgId]
    );

    // Crear suscripción free
    await db.query(
      `INSERT INTO subscriptions (id, organization_id, plan_name, modules, max_users, max_transactions) 
       VALUES (?, ?, 'free', '["bancos"]', 1, 100)`,
      [uuidv4(), orgId]
    );

    res.status(201).json({ id: orgId, name, type });
  } catch (error) {
    next(error);
  }
});

// GET /api/organizations/:id - Detalle
router.get('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const [orgs] = await db.query(
      `SELECT o.*, s.plan_name, s.modules, s.max_users, s.max_transactions,
              (SELECT COUNT(*) FROM user_organizations WHERE organization_id = o.id) as member_count,
              (SELECT COUNT(*) FROM bank_accounts WHERE organization_id = o.id AND is_active = 1) as accounts_count,
              (SELECT COUNT(*) FROM contacts WHERE organization_id = o.id AND is_active = 1) as contacts_count
       FROM organizations o
       LEFT JOIN subscriptions s ON s.organization_id = o.id AND s.is_active = 1
       WHERE o.id = ?`,
      [req.params.id]
    );

    if (!orgs.length) {
      return res.status(404).json({ error: 'Organización no encontrada' });
    }

    res.json({
      ...orgs[0],
      modules: orgs[0].modules ? JSON.parse(orgs[0].modules) : ['bancos'],
      user_role: req.organization.role
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/organizations/:id - Actualizar
router.put('/:id', auth, requireOrg, requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const { name, rfc, tax_regime, legal_name, address, phone, email, logo_url } = req.body;

    await db.query(
      `UPDATE organizations SET 
       name = COALESCE(?, name),
       rfc = COALESCE(?, rfc),
       tax_regime = COALESCE(?, tax_regime),
       legal_name = COALESCE(?, legal_name),
       address = COALESCE(?, address),
       phone = COALESCE(?, phone),
       email = COALESCE(?, email),
       logo_url = COALESCE(?, logo_url)
       WHERE id = ?`,
      [name, rfc, tax_regime, legal_name, address, phone, email, logo_url, req.params.id]
    );

    res.json({ message: 'Organización actualizada' });
  } catch (error) {
    next(error);
  }
});

// GET /api/organizations/:id/members - Miembros del equipo
router.get('/:id/members', auth, requireOrg, async (req, res, next) => {
  try {
    const [members] = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.last_login,
              uo.role, uo.joined_at,
              inv.first_name as invited_by_name
       FROM user_organizations uo
       JOIN users u ON u.id = uo.user_id
       LEFT JOIN users inv ON inv.id = uo.invited_by
       WHERE uo.organization_id = ?
       ORDER BY uo.role, u.first_name`,
      [req.params.id]
    );

    res.json(members);
  } catch (error) {
    next(error);
  }
});

// POST /api/organizations/:id/invite - Invitar miembro
router.post('/:id/invite', auth, requireOrg, requireRole('owner', 'admin'), [
  body('email').isEmail(),
  body('role').isIn(['admin', 'user', 'viewer'])
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, role } = req.body;

    // Buscar usuario
    const [users] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    
    if (!users.length) {
      return res.status(404).json({ error: 'Usuario no encontrado. Debe registrarse primero.' });
    }

    // Verificar si ya es miembro
    const [existing] = await db.query(
      'SELECT id FROM user_organizations WHERE user_id = ? AND organization_id = ?',
      [users[0].id, req.params.id]
    );

    if (existing.length) {
      return res.status(400).json({ error: 'Usuario ya es miembro' });
    }

    await db.query(
      `INSERT INTO user_organizations (id, user_id, organization_id, role, invited_by) 
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), users[0].id, req.params.id, role, req.user.id]
    );

    res.status(201).json({ message: 'Invitación enviada' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/organizations/:id/members/:userId - Remover miembro
router.delete('/:id/members/:userId', auth, requireOrg, requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    if (req.params.userId === req.user.id) {
      return res.status(400).json({ error: 'No puedes removerte a ti mismo' });
    }

    const [member] = await db.query(
      'SELECT role FROM user_organizations WHERE user_id = ? AND organization_id = ?',
      [req.params.userId, req.params.id]
    );

    if (!member.length) {
      return res.status(404).json({ error: 'Miembro no encontrado' });
    }

    if (member[0].role === 'owner') {
      return res.status(400).json({ error: 'No se puede remover al propietario' });
    }

    await db.query(
      'DELETE FROM user_organizations WHERE user_id = ? AND organization_id = ?',
      [req.params.userId, req.params.id]
    );

    res.json({ message: 'Miembro removido' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
