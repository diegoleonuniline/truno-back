const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth, requireOrg, requireModule } = require('../middlewares/auth.middleware');

// POST /api/payments - Registrar pago (a venta o gasto)
router.post('/', auth, requireOrg, [
  body('amount').isDecimal(),
  body('date').isDate(),
  body('payment_method').isIn(['efectivo', 'transferencia', 'cheque', 'tarjeta_debito', 'tarjeta_credito', 'otro'])
], async (req, res, next) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { 
      sale_id, expense_id, payment_schedule_id,
      bank_account_id, amount, date, payment_method, reference, notes 
    } = req.body;

    if (!sale_id && !expense_id) {
      return res.status(400).json({ error: 'Debe especificar sale_id o expense_id' });
    }

    let recordType, record, transactionType;

    if (sale_id) {
      const [sales] = await connection.query(
        'SELECT * FROM sales WHERE id = ? AND organization_id = ?',
        [sale_id, req.organization.id]
      );
      if (!sales.length) {
        return res.status(404).json({ error: 'Venta no encontrada' });
      }
      record = sales[0];
      recordType = 'sale';
      transactionType = 'ingreso';
    } else {
      const [expenses] = await connection.query(
        'SELECT * FROM expenses WHERE id = ? AND organization_id = ?',
        [expense_id, req.organization.id]
      );
      if (!expenses.length) {
        return res.status(404).json({ error: 'Gasto no encontrado' });
      }
      record = expenses[0];
      recordType = 'expense';
      transactionType = 'egreso';
    }

    const pending = parseFloat(record.total) - parseFloat(record.paid_amount);
    if (parseFloat(amount) > pending + 0.01) {
      return res.status(400).json({ error: 'El monto excede el saldo pendiente', pending });
    }

    let bankTransactionId = null;

    // Crear transacción bancaria si se especifica cuenta
    if (bank_account_id) {
      const [accounts] = await connection.query(
        'SELECT id FROM bank_accounts WHERE id = ? AND organization_id = ? AND is_active = 1',
        [bank_account_id, req.organization.id]
      );

      if (!accounts.length) {
        return res.status(400).json({ error: 'Cuenta bancaria no válida' });
      }

      bankTransactionId = uuidv4();
      const description = sale_id 
        ? `Cobro venta ${record.sale_number || record.id.substring(0, 8)}`
        : `Pago gasto ${record.expense_number || record.id.substring(0, 8)}`;

      await connection.query(
        `INSERT INTO bank_transactions 
         (id, organization_id, bank_account_id, type, amount, date, description, payment_method, reference, 
          linked_sale_id, linked_expense_id, created_by) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [bankTransactionId, req.organization.id, bank_account_id, transactionType, amount, date, 
         description, payment_method, reference || null, sale_id || null, expense_id || null, req.user.id]
      );
    }

    // Crear registro de pago
    const paymentId = uuidv4();
    await connection.query(
      `INSERT INTO payments 
       (id, organization_id, bank_transaction_id, payment_schedule_id, sale_id, expense_id, 
        amount, date, payment_method, reference, notes, created_by) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [paymentId, req.organization.id, bankTransactionId, payment_schedule_id || null, 
       sale_id || null, expense_id || null, amount, date, payment_method, reference || null, 
       notes || null, req.user.id]
    );

    // Actualizar monto pagado
    const newPaidAmount = parseFloat(record.paid_amount) + parseFloat(amount);
    const newStatus = newPaidAmount >= parseFloat(record.total) ? 'pagado' : 'parcial';

    if (sale_id) {
      await connection.query(
        'UPDATE sales SET paid_amount = ?, payment_status = ? WHERE id = ?',
        [newPaidAmount, newStatus, sale_id]
      );
    } else {
      await connection.query(
        'UPDATE expenses SET paid_amount = ?, payment_status = ? WHERE id = ?',
        [newPaidAmount, newStatus, expense_id]
      );
    }

    // Actualizar schedule si aplica
    if (payment_schedule_id) {
      const [schedules] = await connection.query(
        'SELECT * FROM payment_schedules WHERE id = ?',
        [payment_schedule_id]
      );

      if (schedules.length) {
        const schedule = schedules[0];
        const newSchedulePaid = parseFloat(schedule.paid_amount) + parseFloat(amount);
        const scheduleStatus = newSchedulePaid >= parseFloat(schedule.amount) ? 'pagado' : 'parcial';

        await connection.query(
          'UPDATE payment_schedules SET paid_amount = ?, status = ? WHERE id = ?',
          [newSchedulePaid, scheduleStatus, payment_schedule_id]
        );
      }
    }

    await connection.commit();

    res.status(201).json({ 
      id: paymentId,
      bank_transaction_id: bankTransactionId,
      new_paid_amount: newPaidAmount,
      new_status: newStatus
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// GET /api/payments - Listar pagos
router.get('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { sale_id, expense_id, start_date, end_date, page = 1, limit = 50 } = req.query;

    let sql = `
      SELECT p.*, 
             s.sale_number, s.total as sale_total,
             e.expense_number, e.total as expense_total,
             ba.name as account_name
      FROM payments p
      LEFT JOIN sales s ON s.id = p.sale_id
      LEFT JOIN expenses e ON e.id = p.expense_id
      LEFT JOIN bank_transactions bt ON bt.id = p.bank_transaction_id
      LEFT JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE p.organization_id = ?
    `;
    const params = [req.organization.id];

    if (sale_id) {
      sql += ' AND p.sale_id = ?';
      params.push(sale_id);
    }
    if (expense_id) {
      sql += ' AND p.expense_id = ?';
      params.push(expense_id);
    }
    if (start_date) {
      sql += ' AND p.date >= ?';
      params.push(start_date);
    }
    if (end_date) {
      sql += ' AND p.date <= ?';
      params.push(end_date);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    sql += ' ORDER BY p.date DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const [payments] = await db.query(sql, params);

    res.json(payments);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/payments/:id - Cancelar pago
router.delete('/:id', auth, requireOrg, async (req, res, next) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [payments] = await connection.query(
      'SELECT * FROM payments WHERE id = ? AND organization_id = ?',
      [req.params.id, req.organization.id]
    );

    if (!payments.length) {
      return res.status(404).json({ error: 'Pago no encontrado' });
    }

    const payment = payments[0];

    // Revertir monto pagado
    if (payment.sale_id) {
      await connection.query(
        `UPDATE sales SET 
         paid_amount = paid_amount - ?,
         payment_status = CASE 
           WHEN paid_amount - ? <= 0 THEN 'pendiente'
           ELSE 'parcial'
         END
         WHERE id = ?`,
        [payment.amount, payment.amount, payment.sale_id]
      );
    } else if (payment.expense_id) {
      await connection.query(
        `UPDATE expenses SET 
         paid_amount = paid_amount - ?,
         payment_status = CASE 
           WHEN paid_amount - ? <= 0 THEN 'pendiente'
           ELSE 'parcial'
         END
         WHERE id = ?`,
        [payment.amount, payment.amount, payment.expense_id]
      );
    }

    // Revertir schedule si aplica
    if (payment.payment_schedule_id) {
      await connection.query(
        `UPDATE payment_schedules SET 
         paid_amount = paid_amount - ?,
         status = CASE 
           WHEN paid_amount - ? <= 0 THEN 'pendiente'
           ELSE 'parcial'
         END
         WHERE id = ?`,
        [payment.amount, payment.amount, payment.payment_schedule_id]
      );
    }

    // Eliminar transacción bancaria si existe
    if (payment.bank_transaction_id) {
      const [trans] = await connection.query(
        'SELECT * FROM bank_transactions WHERE id = ?',
        [payment.bank_transaction_id]
      );

      if (trans.length) {
        const adjustment = trans[0].type === 'ingreso' 
          ? -parseFloat(trans[0].amount) 
          : parseFloat(trans[0].amount);

        await connection.query(
          'UPDATE bank_accounts SET current_balance = current_balance + ? WHERE id = ?',
          [adjustment, trans[0].bank_account_id]
        );

        await connection.query('DELETE FROM bank_transactions WHERE id = ?', [payment.bank_transaction_id]);
      }
    }

    await connection.query('DELETE FROM payments WHERE id = ?', [req.params.id]);

    await connection.commit();
    res.json({ message: 'Pago cancelado' });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// GET /api/payments/pending - Pagos pendientes (por vencer/vencidos)
router.get('/pending', auth, requireOrg, async (req, res, next) => {
  try {
    const { type, days = 30 } = req.query;

    let results = [];

    if (!type || type === 'receivable') {
      const [sales] = await db.query(
        `SELECT 'receivable' as type, s.id, s.sale_number as number, s.date, s.due_date, 
                s.total, s.paid_amount, (s.total - s.paid_amount) as pending,
                c.name as contact_name, s.payment_status,
                DATEDIFF(s.due_date, CURDATE()) as days_until_due
         FROM sales s
         LEFT JOIN contacts c ON c.id = s.contact_id
         WHERE s.organization_id = ? 
         AND s.payment_status IN ('pendiente', 'parcial')
         AND (s.due_date IS NULL OR s.due_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY))
         ORDER BY s.due_date ASC`,
        [req.organization.id, parseInt(days)]
      );
      results = results.concat(sales);
    }

    if (!type || type === 'payable') {
      const [expenses] = await db.query(
        `SELECT 'payable' as type, e.id, e.expense_number as number, e.date, e.due_date,
                e.total, e.paid_amount, (e.total - e.paid_amount) as pending,
                c.name as contact_name, e.payment_status,
                DATEDIFF(e.due_date, CURDATE()) as days_until_due
         FROM expenses e
         LEFT JOIN contacts c ON c.id = e.contact_id
         WHERE e.organization_id = ? 
         AND e.payment_status IN ('pendiente', 'parcial')
         AND (e.due_date IS NULL OR e.due_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY))
         ORDER BY e.due_date ASC`,
        [req.organization.id, parseInt(days)]
      );
      results = results.concat(expenses);
    }

    // Separar vencidos y por vencer
    const overdue = results.filter(r => r.days_until_due !== null && r.days_until_due < 0);
    const upcoming = results.filter(r => r.days_until_due === null || r.days_until_due >= 0);

    res.json({
      overdue,
      upcoming,
      summary: {
        overdue_count: overdue.length,
        overdue_amount: overdue.reduce((sum, r) => sum + parseFloat(r.pending), 0),
        upcoming_count: upcoming.length,
        upcoming_amount: upcoming.reduce((sum, r) => sum + parseFloat(r.pending), 0)
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
