const router = require('express').Router();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth, requireOrg } = require('../middlewares/auth.middleware');

// POST /api/sat/validate - Validar CFDI
router.post('/validate', auth, requireOrg, [
  body('uuid').isUUID(),
  body('rfc_emisor').isLength({ min: 12, max: 13 }),
  body('rfc_receptor').isLength({ min: 12, max: 13 }),
  body('total').isDecimal()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { uuid, rfc_emisor, rfc_receptor, total } = req.body;

    // Primero buscar en caché
    const [cached] = await db.query(
      'SELECT * FROM sat_validations WHERE cfdi_uuid = ? AND expires_at > NOW()',
      [uuid]
    );

    if (cached.length) {
      return res.json({
        status: cached[0].status,
        cached: true,
        validated_at: cached[0].validated_at,
        response: cached[0].response_data ? JSON.parse(cached[0].response_data) : null
      });
    }

    // Llamar a API del SAT (simulada - reemplazar con API real)
    let satResponse;
    try {
      // En producción usar API real del SAT
      // satResponse = await axios.post(process.env.SAT_API_URL, { uuid, rfc_emisor, rfc_receptor, total });
      
      // Simulación para desarrollo
      satResponse = {
        status: 'vigente',
        message: 'CFDI válido y vigente'
      };
    } catch (apiError) {
      satResponse = {
        status: 'error',
        message: apiError.message
      };
    }

    // Guardar en caché
    await db.query(
      `INSERT INTO sat_validations (id, cfdi_uuid, rfc_emisor, rfc_receptor, total, status, response_data) 
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE 
       status = VALUES(status), 
       response_data = VALUES(response_data),
       validated_at = NOW(),
       expires_at = DATE_ADD(NOW(), INTERVAL 7 DAY)`,
      [uuidv4(), uuid, rfc_emisor, rfc_receptor, total, satResponse.status, JSON.stringify(satResponse)]
    );

    res.json({
      status: satResponse.status,
      cached: false,
      validated_at: new Date(),
      response: satResponse
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/sat/validate-batch - Validar múltiples CFDIs
router.post('/validate-batch', auth, requireOrg, [
  body('cfdis').isArray({ min: 1, max: 50 })
], async (req, res, next) => {
  try {
    const { cfdis } = req.body;

    const results = await Promise.all(
      cfdis.map(async (cfdi) => {
        try {
          // Buscar en caché
          const [cached] = await db.query(
            'SELECT status, validated_at FROM sat_validations WHERE cfdi_uuid = ? AND expires_at > NOW()',
            [cfdi.uuid]
          );

          if (cached.length) {
            return {
              uuid: cfdi.uuid,
              status: cached[0].status,
              cached: true,
              validated_at: cached[0].validated_at
            };
          }

          // En producción llamar a API real
          return {
            uuid: cfdi.uuid,
            status: 'vigente',
            cached: false,
            validated_at: new Date()
          };
        } catch (err) {
          return {
            uuid: cfdi.uuid,
            status: 'error',
            error: err.message
          };
        }
      })
    );

    res.json({
      total: results.length,
      vigentes: results.filter(r => r.status === 'vigente').length,
      cancelados: results.filter(r => r.status === 'cancelado').length,
      errores: results.filter(r => r.status === 'error').length,
      results
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/sat/status/:uuid - Consultar estado de CFDI
router.get('/status/:uuid', auth, requireOrg, async (req, res, next) => {
  try {
    const [validations] = await db.query(
      'SELECT * FROM sat_validations WHERE cfdi_uuid = ? ORDER BY validated_at DESC LIMIT 1',
      [req.params.uuid]
    );

    if (!validations.length) {
      return res.status(404).json({ error: 'CFDI no encontrado en caché. Usa /validate para validar.' });
    }

    const validation = validations[0];
    const isExpired = new Date(validation.expires_at) < new Date();

    res.json({
      uuid: validation.cfdi_uuid,
      status: validation.status,
      rfc_emisor: validation.rfc_emisor,
      rfc_receptor: validation.rfc_receptor,
      total: parseFloat(validation.total),
      validated_at: validation.validated_at,
      expires_at: validation.expires_at,
      is_expired: isExpired,
      response: validation.response_data ? JSON.parse(validation.response_data) : null
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/sat/link - Vincular CFDI a venta o gasto
router.post('/link', auth, requireOrg, [
  body('cfdi_uuid').isUUID(),
  body('record_type').isIn(['sale', 'expense']),
  body('record_id').isUUID()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { cfdi_uuid, record_type, record_id, cfdi_folio, cfdi_serie } = req.body;

    // Verificar estado del CFDI
    const [validations] = await db.query(
      'SELECT status FROM sat_validations WHERE cfdi_uuid = ?',
      [cfdi_uuid]
    );

    const satStatus = validations.length ? validations[0].status : null;

    if (record_type === 'sale') {
      const [result] = await db.query(
        `UPDATE sales SET 
         cfdi_uuid = ?, cfdi_folio = ?, cfdi_serie = ?, 
         sat_status = ?, sat_validated_at = NOW()
         WHERE id = ? AND organization_id = ?`,
        [cfdi_uuid, cfdi_folio || null, cfdi_serie || null, satStatus, record_id, req.organization.id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Venta no encontrada' });
      }
    } else {
      const [result] = await db.query(
        `UPDATE expenses SET 
         cfdi_uuid = ?, cfdi_folio = ?, cfdi_serie = ?,
         sat_status = ?, sat_validated_at = NOW()
         WHERE id = ? AND organization_id = ?`,
        [cfdi_uuid, cfdi_folio || null, cfdi_serie || null, satStatus, record_id, req.organization.id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Gasto no encontrado' });
      }
    }

    res.json({ message: 'CFDI vinculado', sat_status: satStatus });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
