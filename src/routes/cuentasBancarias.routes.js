const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth, requireOrg, requireModule } = require('../middlewares/auth.middleware');

// GET /api/cuentas-bancarias
router.get('/', auth, requireOrg, requireModule('bancos'), async (req, res, next) => {
  try {
    const [cuentas] = await db.query(
      `SELECT cb.*,
              (SELECT COUNT(*) FROM transacciones_bancarias WHERE cuenta_bancaria_id = cb.id) as total_transacciones,
              (SELECT MAX(fecha) FROM transacciones_bancarias WHERE cuenta_bancaria_id = cb.id) as ultima_transaccion
       FROM cuentas_bancarias cb
       WHERE cb.organizacion_id = ? AND cb.activo = 1
       ORDER BY cb.nombre`,
      [req.organizacion.id]
    );

    const totales = cuentas.reduce((acc, c) => {
      acc.total += parseFloat(c.saldo_actual) || 0;
      return acc;
    }, { total: 0 });

    res.json({ cuentas, totales });
  } catch (error) {
    next(error);
  }
});

// GET /api/cuentas-bancarias/:id
router.get('/:id', auth, requireOrg, requireModule('bancos'), async (req, res, next) => {
  try {
    const [cuentas] = await db.query(
      `SELECT * FROM cuentas_bancarias WHERE id = ? AND organizacion_id = ?`,
      [req.params.id, req.organizacion.id]
    );

    if (!cuentas.length) {
      return res.status(404).json({ error: 'Cuenta no encontrada' });
    }

    res.json(cuentas[0]);
  } catch (error) {
    next(error);
  }
});

// POST /api/cuentas-bancarias
router.post('/', auth, requireOrg, requireModule('bancos'), [
  body('nombre').trim().notEmpty(),
  body('moneda').optional().isLength({ min: 3, max: 3 }),
  body('saldo_inicial').optional().isDecimal()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { nombre, nombre_banco, numero_cuenta, clabe, moneda, saldo_inicial, notas } = req.body;

    const cuentaId = uuidv4();
    const saldoInicial = parseFloat(saldo_inicial) || 0;

    await db.query(
      `INSERT INTO cuentas_bancarias 
       (id, organizacion_id, nombre, nombre_banco, numero_cuenta, clabe, moneda, saldo_inicial, saldo_actual, notas, creado_por) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cuentaId, req.organizacion.id, nombre, nombre_banco || null, numero_cuenta || null, 
       clabe || null, moneda || 'MXN', saldoInicial, saldoInicial, notas || null, req.usuario.id]
    );

    res.status(201).json({ 
      id: cuentaId, 
      nombre, 
      saldo_actual: saldoInicial,
      moneda: moneda || 'MXN'
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/cuentas-bancarias/:id
router.put('/:id', auth, requireOrg, requireModule('bancos'), async (req, res, next) => {
  try {
    const { nombre, nombre_banco, numero_cuenta, clabe, notas } = req.body;

    const [result] = await db.query(
      `UPDATE cuentas_bancarias SET 
       nombre = COALESCE(?, nombre),
       nombre_banco = COALESCE(?, nombre_banco),
       numero_cuenta = COALESCE(?, numero_cuenta),
       clabe = COALESCE(?, clabe),
       notas = COALESCE(?, notas)
       WHERE id = ? AND organizacion_id = ?`,
      [nombre, nombre_banco, numero_cuenta, clabe, notas, req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Cuenta no encontrada' });
    }

    res.json({ mensaje: 'Cuenta actualizada' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/cuentas-bancarias/:id
router.delete('/:id', auth, requireOrg, requireModule('bancos'), async (req, res, next) => {
  try {
    const [result] = await db.query(
      `UPDATE cuentas_bancarias SET activo = 0 WHERE id = ? AND organizacion_id = ?`,
      [req.params.id, req.organizacion.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Cuenta no encontrada' });
    }

    res.json({ mensaje: 'Cuenta eliminada' });
  } catch (error) {
    next(error);
  }
});

// POST /api/cuentas-bancarias/:id/ajustar
router.post('/:id/ajustar', auth, requireOrg, requireModule('bancos'), [
  body('nuevo_saldo').isDecimal(),
  body('motivo').trim().notEmpty()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { nuevo_saldo, motivo } = req.body;

    const [cuentas] = await db.query(
      'SELECT saldo_actual FROM cuentas_bancarias WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (!cuentas.length) {
      return res.status(404).json({ error: 'Cuenta no encontrada' });
    }

    const diferencia = parseFloat(nuevo_saldo) - parseFloat(cuentas[0].saldo_actual);
    const tipo = diferencia >= 0 ? 'ingreso' : 'egreso';

    await db.query(
      `INSERT INTO transacciones_bancarias 
       (id, organizacion_id, cuenta_bancaria_id, tipo, monto, fecha, descripcion, metodo_pago, creado_por) 
       VALUES (?, ?, ?, ?, ?, CURDATE(), ?, 'otro', ?)`,
      [uuidv4(), req.organizacion.id, req.params.id, tipo, Math.abs(diferencia), 
       `Ajuste: ${motivo}`, req.usuario.id]
    );

    res.json({ mensaje: 'Saldo ajustado', nuevo_saldo: parseFloat(nuevo_saldo) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
