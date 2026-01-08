const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, query, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth, requireOrg, requireModule } = require('../middlewares/auth.middleware');

// GET /api/transactions
router.get('/', auth, requireOrg, requireModule('bancos'), async (req, res, next) => {
  try {
    const { 
      account_id, type, category, start_date, end_date, 
      search, page = 1, limit = 50 
    } = req.query;

    let sql = `
      SELECT bt.*, ba.name as account_name, ba.currency,
             c.name as contact_name,
             s.sale_number as linked_sale_number,
             e.expense_number as linked_expense_number
      FROM bank_transactions bt
      JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      LEFT JOIN contacts c ON c.id = (
        SELECT contact_id FROM sales WHERE id = bt.linked_sale_id
        UNION
        SELECT contact_id FROM expenses WHERE id = bt.linked_expense_id
        LIMIT 1
      )
      LEFT JOIN sales s ON s.id = bt.linked_sale_id
      LEFT JOIN expenses e ON e.id = bt.linked_expense_id
      WHERE bt.organization_id = ?
    `;
    const params = [req.organization.id];

    if (account_id) {
      sql += ' AND bt.bank_account_id = ?';
      params.push(account_id);
    }
    if (type) {
      sql += ' AND bt.type = ?';
      params.push(type);
    }
    if (category) {
      sql += ' AND bt.category = ?';
      params.push(category);
    }
    if (start_date) {
      sql += ' AND bt.date >= ?';
      params.push(start_date);
    }
    if (end_date) {
      sql += ' AND bt.date <= ?';
      params.push(end_date);
    }
    if (search) {
      sql += ' AND (bt.description LIKE ? OR bt.reference LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    // Count total
    const countSql = sql.replace(/SELECT .* FROM/, 'SELECT COUNT(*) as total FROM');
    const [[{ total }]] = await db.query(countSql, params);

    // Pagination
    const offset = (parseInt(page) - 1) * parseInt(limit);
    sql += ' ORDER BY bt.date DESC, bt.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const [transactions] = await db.query(sql, params);

    // Balance filtrado
    const [balanceResult] = await db.query(`
      SELECT 
        SUM(CASE WHEN type = 'ingreso' THEN amount ELSE 0 END) as total_ingresos,
        SUM(CASE WHEN type = 'egreso' THEN amount ELSE 0 END) as total_egresos
      FROM bank_transactions
      WHERE organization_id = ?
      ${account_id ? 'AND bank_account_id = ?' : ''}
      ${start_date ? 'AND date >= ?' : ''}
      ${end_date ? 'AND date <= ?' : ''}
    `, [req.organization.id, ...(account_id ? [account_id] : []), 
        ...(start_date ? [start_date] : []), ...(end_date ? [end_date] : [])]);

    res.json({
      transactions,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      },
      summary: {
        ingresos: parseFloat(balanceResult[0]?.total_ingresos) || 0,
        egresos: parseFloat(balanceResult[0]?.total_egresos) || 0,
        balance: (parseFloat(balanceResult[0]?.total_ingresos) || 0) - 
                 (parseFloat(balanceResult[0]?.total_egresos) || 0)
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/transactions/:id
router.get('/:id', auth, requireOrg, requireModule('bancos'), async (req, res, next) => {
  try {
    const [transactions] = await db.query(
      `SELECT bt.*, ba.name as account_name, ba.currency,
              s.*, e.*
       FROM bank_transactions bt
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
       LEFT JOIN sales s ON s.id = bt.linked_sale_id
       LEFT JOIN expenses e ON e.id = bt.linked_expense_id
       WHERE bt.id = ? AND bt.organization_id = ?`,
      [req.params.id, req.organization.id]
    );

    if (!transactions.length) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    res.json(transactions[0]);
  } catch (error) {
    next(error);
  }
});

// POST /api/transactions - Registro simple
router.post('/', auth, requireOrg, requireModule('bancos'), [
  body('bank_account_id').isUUID(),
  body('type').isIn(['ingreso', 'egreso']),
  body('amount').isDecimal({ decimal_digits: '0,2' }),
  body('date').isDate(),
  body('description').trim().notEmpty()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { 
      bank_account_id, type, amount, date, description, 
      payment_method, reference, category, notes 
    } = req.body;

    // Verificar cuenta
    const [accounts] = await db.query(
      'SELECT id FROM bank_accounts WHERE id = ? AND organization_id = ? AND is_active = 1',
      [bank_account_id, req.organization.id]
    );

    if (!accounts.length) {
      return res.status(400).json({ error: 'Cuenta bancaria no válida' });
    }

    const transactionId = uuidv4();

    await db.query(
      `INSERT INTO bank_transactions 
       (id, organization_id, bank_account_id, type, amount, date, description, payment_method, reference, category, notes, created_by) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [transactionId, req.organization.id, bank_account_id, type, amount, date, 
       description, payment_method || null, reference || null, category || null, 
       notes || null, req.user.id]
    );

    // Obtener balance actualizado
    const [balances] = await db.query(
      'SELECT current_balance FROM bank_accounts WHERE id = ?',
      [bank_account_id]
    );

    res.status(201).json({ 
      id: transactionId,
      balance_after: parseFloat(balances[0].current_balance)
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/transactions/transfer - Transferencia entre cuentas
router.post('/transfer', auth, requireOrg, requireModule('bancos'), [
  body('from_account_id').isUUID(),
  body('to_account_id').isUUID(),
  body('amount').isDecimal({ decimal_digits: '0,2' }),
  body('date').isDate()
], async (req, res, next) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { from_account_id, to_account_id, amount, date, description, reference } = req.body;

    if (from_account_id === to_account_id) {
      return res.status(400).json({ error: 'Las cuentas deben ser diferentes' });
    }

    // Verificar ambas cuentas
    const [accounts] = await connection.query(
      'SELECT id, name FROM bank_accounts WHERE id IN (?, ?) AND organization_id = ? AND is_active = 1',
      [from_account_id, to_account_id, req.organization.id]
    );

    if (accounts.length !== 2) {
      return res.status(400).json({ error: 'Cuentas no válidas' });
    }

    const transferPairId = uuidv4();
    const egresoId = uuidv4();
    const ingresoId = uuidv4();
    const desc = description || 'Transferencia entre cuentas';

    // Egreso
    await connection.query(
      `INSERT INTO bank_transactions 
       (id, organization_id, bank_account_id, type, amount, date, description, payment_method, reference, is_internal_transfer, transfer_pair_id, created_by) 
       VALUES (?, ?, ?, 'egreso', ?, ?, ?, 'transferencia', ?, 1, ?, ?)`,
      [egresoId, req.organization.id, from_account_id, amount, date, desc, reference || null, transferPairId, req.user.id]
    );

    // Ingreso
    await connection.query(
      `INSERT INTO bank_transactions 
       (id, organization_id, bank_account_id, type, amount, date, description, payment_method, reference, is_internal_transfer, transfer_pair_id, created_by) 
       VALUES (?, ?, ?, 'ingreso', ?, ?, ?, 'transferencia', ?, 1, ?, ?)`,
      [ingresoId, req.organization.id, to_account_id, amount, date, desc, reference || null, transferPairId, req.user.id]
    );

    await connection.commit();

    res.status(201).json({ 
      transfer_pair_id: transferPairId,
      egreso_id: egresoId,
      ingreso_id: ingresoId
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// PUT /api/transactions/:id
router.put('/:id', auth, requireOrg, requireModule('bancos'), async (req, res, next) => {
  try {
    const { description, category, reference, notes, payment_method } = req.body;

    // No permitir editar transacciones vinculadas
    const [trans] = await db.query(
      'SELECT linked_sale_id, linked_expense_id, is_internal_transfer FROM bank_transactions WHERE id = ? AND organization_id = ?',
      [req.params.id, req.organization.id]
    );

    if (!trans.length) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    if (trans[0].linked_sale_id || trans[0].linked_expense_id) {
      return res.status(400).json({ error: 'No se puede editar transacciones vinculadas a ventas/gastos' });
    }

    await db.query(
      `UPDATE bank_transactions SET 
       description = COALESCE(?, description),
       category = COALESCE(?, category),
       reference = COALESCE(?, reference),
       notes = COALESCE(?, notes),
       payment_method = COALESCE(?, payment_method)
       WHERE id = ? AND organization_id = ?`,
      [description, category, reference, notes, payment_method, req.params.id, req.organization.id]
    );

    res.json({ message: 'Transacción actualizada' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/transactions/:id
router.delete('/:id', auth, requireOrg, requireModule('bancos'), async (req, res, next) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [trans] = await connection.query(
      `SELECT bt.*, ba.current_balance 
       FROM bank_transactions bt
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
       WHERE bt.id = ? AND bt.organization_id = ?`,
      [req.params.id, req.organization.id]
    );

    if (!trans.length) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    if (trans[0].linked_sale_id || trans[0].linked_expense_id) {
      return res.status(400).json({ error: 'No se puede eliminar transacciones vinculadas' });
    }

    // Revertir balance
    const adjustment = trans[0].type === 'ingreso' 
      ? -parseFloat(trans[0].amount) 
      : parseFloat(trans[0].amount);

    await connection.query(
      'UPDATE bank_accounts SET current_balance = current_balance + ? WHERE id = ?',
      [adjustment, trans[0].bank_account_id]
    );

    // Si es transferencia, eliminar par
    if (trans[0].is_internal_transfer && trans[0].transfer_pair_id) {
      const [pairTrans] = await connection.query(
        'SELECT * FROM bank_transactions WHERE transfer_pair_id = ? AND id != ?',
        [trans[0].transfer_pair_id, req.params.id]
      );

      if (pairTrans.length) {
        const pairAdjustment = pairTrans[0].type === 'ingreso' 
          ? -parseFloat(pairTrans[0].amount) 
          : parseFloat(pairTrans[0].amount);

        await connection.query(
          'UPDATE bank_accounts SET current_balance = current_balance + ? WHERE id = ?',
          [pairAdjustment, pairTrans[0].bank_account_id]
        );

        await connection.query(
          'DELETE FROM bank_transactions WHERE transfer_pair_id = ?',
          [trans[0].transfer_pair_id]
        );
      }
    } else {
      await connection.query(
        'DELETE FROM bank_transactions WHERE id = ?',
        [req.params.id]
      );
    }

    await connection.commit();
    res.json({ message: 'Transacción eliminada' });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// POST /api/transactions/:id/convert - Convertir a registro avanzado
router.post('/:id/convert', auth, requireOrg, async (req, res, next) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const { convert_to } = req.body; // 'sale' o 'expense'

    const [trans] = await connection.query(
      'SELECT * FROM bank_transactions WHERE id = ? AND organization_id = ?',
      [req.params.id, req.organization.id]
    );

    if (!trans.length) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    if (trans[0].linked_sale_id || trans[0].linked_expense_id) {
      return res.status(400).json({ error: 'Transacción ya vinculada' });
    }

    const t = trans[0];
    const recordId = uuidv4();

    if (convert_to === 'sale' && t.type === 'ingreso') {
      // Crear venta
      await connection.query(
        `INSERT INTO sales 
         (id, organization_id, date, subtotal, total, payment_status, paid_amount, notes, created_by)
         VALUES (?, ?, ?, ?, ?, 'pagado', ?, ?, ?)`,
        [recordId, req.organization.id, t.date, t.amount, t.amount, t.amount, t.description, req.user.id]
      );

      await connection.query(
        'UPDATE bank_transactions SET linked_sale_id = ? WHERE id = ?',
        [recordId, t.id]
      );

    } else if (convert_to === 'expense' && t.type === 'egreso') {
      // Crear gasto
      await connection.query(
        `INSERT INTO expenses 
         (id, organization_id, date, subtotal, total, payment_status, paid_amount, category, notes, created_by)
         VALUES (?, ?, ?, ?, ?, 'pagado', ?, ?, ?, ?)`,
        [recordId, req.organization.id, t.date, t.amount, t.amount, t.amount, t.category, t.description, req.user.id]
      );

      await connection.query(
        'UPDATE bank_transactions SET linked_expense_id = ? WHERE id = ?',
        [recordId, t.id]
      );

    } else {
      return res.status(400).json({ error: 'Tipo de conversión no válido' });
    }

    await connection.commit();
    res.json({ id: recordId, type: convert_to });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

module.exports = router;
