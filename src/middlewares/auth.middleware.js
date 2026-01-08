const jwt = require('jsonwebtoken');
const db = require('../config/database');

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'Token no proporcionado' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const [users] = await db.query(
      'SELECT id, email, first_name, last_name, is_active FROM users WHERE id = ?',
      [decoded.userId]
    );

    if (!users.length || !users[0].is_active) {
      return res.status(401).json({ error: 'Usuario no válido' });
    }

    req.user = users[0];
    req.token = token;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado' });
    }
    res.status(401).json({ error: 'Token inválido' });
  }
};

const requireOrg = async (req, res, next) => {
  try {
    const orgId = req.header('X-Organization-Id');
    
    if (!orgId) {
      return res.status(400).json({ error: 'Organización no especificada' });
    }

    const [userOrgs] = await db.query(
      `SELECT uo.*, o.name as org_name, o.is_active as org_active,
              s.plan_name, s.modules
       FROM user_organizations uo
       JOIN organizations o ON o.id = uo.organization_id
       LEFT JOIN subscriptions s ON s.organization_id = o.id AND s.is_active = 1
       WHERE uo.user_id = ? AND uo.organization_id = ?`,
      [req.user.id, orgId]
    );

    if (!userOrgs.length) {
      return res.status(403).json({ error: 'Sin acceso a esta organización' });
    }

    if (!userOrgs[0].org_active) {
      return res.status(403).json({ error: 'Organización inactiva' });
    }

    req.organization = {
      id: orgId,
      name: userOrgs[0].org_name,
      role: userOrgs[0].role,
      plan: userOrgs[0].plan_name || 'free',
      modules: userOrgs[0].modules ? JSON.parse(userOrgs[0].modules) : ['bancos']
    };

    next();
  } catch (error) {
    next(error);
  }
};

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.organization.role)) {
      return res.status(403).json({ error: 'Permisos insuficientes' });
    }
    next();
  };
};

const requireModule = (moduleName) => {
  return (req, res, next) => {
    if (!req.organization.modules.includes(moduleName)) {
      return res.status(403).json({ 
        error: `Módulo "${moduleName}" no disponible en tu plan`,
        upgrade: true
      });
    }
    next();
  };
};

module.exports = { auth, requireOrg, requireRole, requireModule };
