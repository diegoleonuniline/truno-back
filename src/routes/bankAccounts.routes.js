const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, query, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth, requireOrg, requireModule } = require('../middlewares/auth.middleware');

// GET /api/bank-accounts
router.get('/', auth, requireOrg, requireModule('bancos'), async (req, res, next) => {
  try {
    const [accounts] = await db.query(
      `SELECT ba.*,
              (SELECT COUNT(*) FROM bank_transactions WHERE bank_account_id = ba.id) as transaction_count,
              (SELECT MAX(date) FROM bank_transactions WHERE bank_account_id = ba.id) as last_transaction
       FROM bank_accounts ba
       WHERE ba.organization_id = ? AND ba.is_active = 1
       ORDER BY ba.name`,
      [req.organization.id]
    );

    // Calcular totales en paralelo
    const totals = accounts.reduce((acc, a) => {
      acc.total += parseFloat(a.current_balance) || 0;
      return acc;
    }, { total: 0 });

    res.json({ accounts, totals });
  } catch (error) {
    next(error);
  }
});

// GET /api/bank-accounts/:id
router.get('/:id', auth, requireOrg, requireModule('bancos'), async (req, res, next) => {
  try {
    const [accounts] = await db.query(
      `SELECT * FROM bank_accounts WHERE id = ? AND organization_id = ?`,
      [req.params.id, req.organization.id]
    );

    if (!accounts.length) {
      return res.status(404).json({ error: 'Cuenta no encontrada' });
    }

    res.json(accounts[0]);
  } catch (error) {
    next(error);
  }
});

// POST /api/bank-accounts
router.post('/', auth, requireOrg, requireModule('bancos'), [
  body('name').trim().notEmpty(),
  body('currency').optional().isLength({ min: 3, max: 3 }),
  body('initial_balance').optional().isDecimal()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, bank_name, account_number, clabe, currency, initial_balance, notes } = req.body;

    const accountId = uuidv4();
    const initialBal = parseFloat(initial_balance) || 0;

    await db.query(
      `INSERT INTO bank_accounts 
       (id, organization_id, name, bank_name, account_number, clabe, currency, initial_balance, current_balance, notes, created_by) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [accountId, req.organization.id, name, bank_name || null, account_number || null, 
       clabe || null, currency || 'MXN', initialBal, initialBal, notes || null, req.user.id]
    );

    res.status(201).json({ 
      id: accountId, 
      name, 
      current_balance: initialBal,
      currency: currency || 'MXN'
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/bank-accounts/:id
router.put('/:id', auth, requireOrg, requireModule('bancos'), async (req, res, next) => {
  try {
    const { name, bank_name, account_number, clabe, notes } = req.body;

    const [result] = await db.query(
      `UPDATE bank_accounts SET 
       name = COALESCE(?, name),
       bank_name = COALESCE(?, bank_name),
       account_number = COALESCE(?, account_number),
       clabe = COALESCE(?, clabe),
       notes = COALESCE(?, notes)
       WHERE id = ? AND organization_id = ?`,
      [name, bank_name, account_number, clabe, notes, req.params.id, req.organization.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Cuenta no encontrada' });
    }

    res.json({ message: 'Cuenta actualizada' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/bank-accounts/:id (soft delete)
router.delete('/:id', auth, requireOrg, requireModule('bancos'), async (req, res, next) => {
  try {
    const [result] = await db.query(
      `UPDATE bank_accounts SET is_active = 0 WHERE id = ? AND organization_id = ?`,
      [req.params.id, req.organization.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Cuenta no encontrada' });
    }

    res.json({ message: 'Cuenta eliminada' });
  } catch (error) {
    next(error);
  }
});

// POST /api/bank-accounts/:id/adjust - Ajuste de saldo
router.post('/:id/adjust', auth, requireOrg, requireModule('bancos'), [
  body('new_balance').isDecimal(),
  body('reason').trim().notEmpty()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { new_balance, reason } = req.body;

    const [accounts] = await db.query(
      'SELECT current_balance FROM bank_accounts WHERE id = ? AND organization_id = ?',
      [req.params.id, req.organization.id]
    );

    if (!accounts.length) {
      return res.status(404).json({ error: 'Cuenta no encontrada' });
    }

    const diff = parseFloat(new_balance) - parseFloat(accounts[0].current_balance);
    const type = diff >= 0 ? 'ingreso' : 'egreso';

    // Crear transacción de ajuste
    await db.query(
      `INSERT INTO bank_transactions 
       (id, organization_id, bank_account_id, type, amount, date, description, payment_method, created_by) 
       VALUES (?, ?, ?, ?, ?, CURDATE(), ?, 'otro', ?)`,
      [uuidv4(), req.organization.id, req.params.id, type, Math.abs(diff), 
       `Ajuste: ${reason}`, req.user.id]
    );

    res.json({ message: 'Saldo ajustado', new_balance: parseFloat(new_balance) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
