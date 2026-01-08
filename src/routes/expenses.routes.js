const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth, requireOrg, requireModule } = require('../middlewares/auth.middleware');

// GET /api/expenses
router.get('/', auth, requireOrg, requireModule('gastos'), async (req, res, next) => {
  try {
    const { 
      contact_id, status, category, start_date, end_date, 
      search, page = 1, limit = 50 
    } = req.query;

    let sql = `
      SELECT e.*, c.name as contact_name, c.rfc as contact_rfc
      FROM expenses e
      LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE e.organization_id = ?
    `;
    const params = [req.organization.id];

    if (contact_id) {
      sql += ' AND e.contact_id = ?';
      params.push(contact_id);
    }
    if (status) {
      sql += ' AND e.payment_status = ?';
      params.push(status);
    }
    if (category) {
      sql += ' AND e.category = ?';
      params.push(category);
    }
    if (start_date) {
      sql += ' AND e.date >= ?';
      params.push(start_date);
    }
    if (end_date) {
      sql += ' AND e.date <= ?';
      params.push(end_date);
    }
    if (search) {
      sql += ' AND (e.expense_number LIKE ? OR e.cfdi_uuid LIKE ? OR c.name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const countSql = sql.replace(/SELECT .* FROM/, 'SELECT COUNT(*) as total FROM');
    const [[{ total }]] = await db.query(countSql, params);

    const offset = (parseInt(page) - 1) * parseInt(limit);
    sql += ' ORDER BY e.date DESC, e.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const [expenses] = await db.query(sql, params);

    res.json({
      expenses,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/expenses/:id
router.get('/:id', auth, requireOrg, requireModule('gastos'), async (req, res, next) => {
  try {
    const [expenses] = await db.query(
      `SELECT e.*, c.name as contact_name, c.rfc as contact_rfc, c.email as contact_email
       FROM expenses e
       LEFT JOIN contacts c ON c.id = e.contact_id
       WHERE e.id = ? AND e.organization_id = ?`,
      [req.params.id, req.organization.id]
    );

    if (!expenses.length) {
      return res.status(404).json({ error: 'Gasto no encontrado' });
    }

    const [items] = await db.query('SELECT * FROM expense_items WHERE expense_id = ?', [req.params.id]);

    const [payments] = await db.query(
      `SELECT p.*, bt.bank_account_id, ba.name as account_name
       FROM payments p
       LEFT JOIN bank_transactions bt ON bt.id = p.bank_transaction_id
       LEFT JOIN bank_accounts ba ON ba.id = bt.bank_account_id
       WHERE p.expense_id = ?
       ORDER BY p.date DESC`,
      [req.params.id]
    );

    const [schedule] = await db.query(
      'SELECT * FROM payment_schedules WHERE expense_id = ? ORDER BY due_date',
      [req.params.id]
    );

    res.json({
      ...expenses[0],
      items,
      payments,
      schedule
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/expenses
router.post('/', auth, requireOrg, requireModule('gastos'), [
  body('date').isDate(),
  body('total').isDecimal()
], async (req, res, next) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { 
      contact_id, expense_number, date, due_date, items, 
      subtotal, tax, discount, total, category,
      currency, exchange_rate, notes, cfdi_uuid, cfdi_folio, cfdi_serie,
      xml_file_url, pdf_file_url
    } = req.body;

    const expenseId = uuidv4();

    await connection.query(
      `INSERT INTO expenses 
       (id, organization_id, contact_id, expense_number, date, due_date, cfdi_uuid, cfdi_folio, cfdi_serie,
        subtotal, tax, discount, total, category, currency, exchange_rate, notes, xml_file_url, pdf_file_url, created_by) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [expenseId, req.organization.id, contact_id || null, expense_number || null, date, due_date || null,
       cfdi_uuid || null, cfdi_folio || null, cfdi_serie || null, 
       subtotal || total, tax || 0, discount || 0, total, category || null,
       currency || 'MXN', exchange_rate || 1, notes || null, xml_file_url || null, pdf_file_url || null, req.user.id]
    );

    // Items opcionales
    if (items && items.length) {
      for (const item of items) {
        const itemSubtotal = item.quantity * item.unit_price - (item.discount || 0);
        const itemTax = itemSubtotal * (item.tax_rate || 16) / 100;

        await connection.query(
          `INSERT INTO expense_items 
           (id, expense_id, product_code, description, quantity, unit_price, discount, tax_rate, subtotal, tax, total) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), expenseId, item.product_code || null, item.description, item.quantity, 
           item.unit_price, item.discount || 0, item.tax_rate || 16, itemSubtotal, itemTax, itemSubtotal + itemTax]
        );
      }
    }

    await connection.commit();
    res.status(201).json({ id: expenseId, total });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// PUT /api/expenses/:id
router.put('/:id', auth, requireOrg, requireModule('gastos'), async (req, res, next) => {
  try {
    const { 
      contact_id, expense_number, date, due_date, category, notes,
      cfdi_uuid, cfdi_folio, cfdi_serie, xml_file_url, pdf_file_url
    } = req.body;

    const [result] = await db.query(
      `UPDATE expenses SET 
       contact_id = COALESCE(?, contact_id),
       expense_number = COALESCE(?, expense_number),
       date = COALESCE(?, date),
       due_date = COALESCE(?, due_date),
       category = COALESCE(?, category),
       notes = COALESCE(?, notes),
       cfdi_uuid = COALESCE(?, cfdi_uuid),
       cfdi_folio = COALESCE(?, cfdi_folio),
       cfdi_serie = COALESCE(?, cfdi_serie),
       xml_file_url = COALESCE(?, xml_file_url),
       pdf_file_url = COALESCE(?, pdf_file_url)
       WHERE id = ? AND organization_id = ?`,
      [contact_id, expense_number, date, due_date, category, notes, cfdi_uuid, cfdi_folio, cfdi_serie,
       xml_file_url, pdf_file_url, req.params.id, req.organization.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Gasto no encontrado' });
    }

    res.json({ message: 'Gasto actualizado' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/expenses/:id
router.delete('/:id', auth, requireOrg, requireModule('gastos'), async (req, res, next) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [expenses] = await connection.query(
      'SELECT paid_amount FROM expenses WHERE id = ? AND organization_id = ?',
      [req.params.id, req.organization.id]
    );

    if (!expenses.length) {
      return res.status(404).json({ error: 'Gasto no encontrado' });
    }

    if (parseFloat(expenses[0].paid_amount) > 0) {
      return res.status(400).json({ error: 'No se puede eliminar un gasto con pagos registrados' });
    }

    await connection.query(
      'UPDATE bank_transactions SET linked_expense_id = NULL WHERE linked_expense_id = ?',
      [req.params.id]
    );

    await connection.query('DELETE FROM expense_items WHERE expense_id = ?', [req.params.id]);
    await connection.query('DELETE FROM payment_schedules WHERE expense_id = ?', [req.params.id]);
    await connection.query('DELETE FROM expenses WHERE id = ?', [req.params.id]);

    await connection.commit();
    res.json({ message: 'Gasto eliminado' });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// POST /api/expenses/:id/schedule
router.post('/:id/schedule', auth, requireOrg, requireModule('gastos'), [
  body('installments').isArray({ min: 1 })
], async (req, res, next) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const { installments } = req.body;

    const [expenses] = await connection.query(
      'SELECT total, paid_amount FROM expenses WHERE id = ? AND organization_id = ?',
      [req.params.id, req.organization.id]
    );

    if (!expenses.length) {
      return res.status(404).json({ error: 'Gasto no encontrado' });
    }

    const pending = parseFloat(expenses[0].total) - parseFloat(expenses[0].paid_amount);
    const totalScheduled = installments.reduce((sum, i) => sum + parseFloat(i.amount), 0);

    if (Math.abs(totalScheduled - pending) > 0.01) {
      return res.status(400).json({ 
        error: 'La suma de parcialidades debe ser igual al saldo pendiente',
        pending,
        scheduled: totalScheduled
      });
    }

    await connection.query('DELETE FROM payment_schedules WHERE expense_id = ?', [req.params.id]);

    for (let i = 0; i < installments.length; i++) {
      await connection.query(
        `INSERT INTO payment_schedules 
         (id, organization_id, expense_id, installment_number, due_date, amount) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), req.organization.id, req.params.id, i + 1, installments[i].due_date, installments[i].amount]
      );
    }

    await connection.commit();
    res.status(201).json({ message: 'Programación creada', installments: installments.length });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// GET /api/expenses/categories - Lista de categorías usadas
router.get('/meta/categories', auth, requireOrg, async (req, res, next) => {
  try {
    const [categories] = await db.query(
      `SELECT DISTINCT category, COUNT(*) as count 
       FROM expenses 
       WHERE organization_id = ? AND category IS NOT NULL
       GROUP BY category
       ORDER BY count DESC`,
      [req.organization.id]
    );

    res.json(categories);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
