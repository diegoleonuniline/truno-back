const jwt = require('jsonwebtoken');
const db = require('../config/database');

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'Token no proporcionado' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const [usuarios] = await db.query(
      'SELECT id, correo, nombre, apellido, activo FROM usuarios WHERE id = ?',
      [decoded.usuarioId]
    );

    if (!usuarios.length || !usuarios[0].activo) {
      return res.status(401).json({ error: 'Usuario no válido' });
    }

    req.usuario = usuarios[0];
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
      `SELECT uo.*, o.nombre as org_nombre, o.activo as org_activo,
              s.nombre_plan, s.modulos
       FROM usuario_organizaciones uo
       JOIN organizaciones o ON o.id = uo.organizacion_id
       LEFT JOIN suscripciones s ON s.organizacion_id = o.id AND s.activo = 1
       WHERE uo.usuario_id = ? AND uo.organizacion_id = ?`,
      [req.usuario.id, orgId]
    );

    if (!userOrgs.length) {
      return res.status(403).json({ error: 'Sin acceso a esta organización' });
    }

    if (!userOrgs[0].org_activo) {
      return res.status(403).json({ error: 'Organización inactiva' });
    }

    req.organizacion = {
      id: orgId,
      nombre: userOrgs[0].org_nombre,
      rol: userOrgs[0].rol,
      plan: userOrgs[0].nombre_plan || 'free',
      modulos: userOrgs[0].modulos ? JSON.parse(userOrgs[0].modulos) : ['bancos']
    };

    next();
  } catch (error) {
    next(error);
  }
};

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.organizacion.rol)) {
      return res.status(403).json({ error: 'Permisos insuficientes' });
    }
    next();
  };
};

const requireModule = (moduleName) => {
  return (req, res, next) => {
    // Temporalmente deshabilitado para desarrollo
    // if (!req.organizacion.modulos.includes(moduleName)) {
    //   return res.status(403).json({ 
    //     error: `Módulo "${moduleName}" no disponible en tu plan`,
    //     upgrade: true
    //   });
    // }
    next();
  };
};

module.exports = { auth, requireOrg, requireRole, requireModule };
