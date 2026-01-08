const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, query, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth, requireOrg, requireModule } = require('../middlewares/auth.middleware');

// GET /api/contacts
router.get('/', auth, requireOrg, requireModule('contactos'), async (req, res, next) => {
  try {
    const { type, search, page = 1, limit = 50 } = req.query;

    let sql = `
      SELECT c.*,
             (SELECT COUNT(*) FROM sales WHERE contact_id = c.id) as sales_count,
             (SELECT COUNT(*) FROM expenses WHERE contact_id = c.id) as expenses_count,
             (SELECT COALESCE(SUM(total - paid_amount), 0) FROM sales WHERE contact_id = c.id AND payment_status IN ('pendiente', 'parcial')) as pending_receivable,
             (SELECT COALESCE(SUM(total - paid_amount), 0) FROM expenses WHERE contact_id = c.id AND payment_status IN ('pendiente', 'parcial')) as pending_payable
      FROM contacts c
      WHERE c.organization_id = ? AND c.is_active = 1
    `;
    const params = [req.organization.id];

    if (type) {
      if (type === 'cliente') {
        sql += " AND c.type IN ('cliente', 'ambos')";
      } else if (type === 'proveedor') {
        sql += " AND c.type IN ('proveedor', 'ambos')";
      }
    }

    if (search) {
      sql += ' AND (c.name LIKE ? OR c.legal_name LIKE ? OR c.rfc LIKE ? OR c.email LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    // Count
    const countSql = sql.replace(/SELECT .* FROM/, 'SELECT COUNT(*) as total FROM');
    const [[{ total }]] = await db.query(countSql, params);

    const offset = (parseInt(page) - 1) * parseInt(limit);
    sql += ' ORDER BY c.name LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const [contacts] = await db.query(sql, params);

    res.json({
      contacts,
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

// GET /api/contacts/:id
router.get('/:id', auth, requireOrg, requireModule('contactos'), async (req, res, next) => {
  try {
    const [contacts] = await db.query(
      `SELECT c.*,
              (SELECT COALESCE(SUM(total), 0) FROM sales WHERE contact_id = c.id) as total_sales,
              (SELECT COALESCE(SUM(total), 0) FROM expenses WHERE contact_id = c.id) as total_expenses
       FROM contacts c
       WHERE c.id = ? AND c.organization_id = ?`,
      [req.params.id, req.organization.id]
    );

    if (!contacts.length) {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }

    res.json(contacts[0]);
  } catch (error) {
    next(error);
  }
});

// POST /api/contacts
router.post('/', auth, requireOrg, requireModule('contactos'), [
  body('name').trim().notEmpty(),
  body('type').isIn(['cliente', 'proveedor', 'ambos'])
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { 
      type, name, legal_name, rfc, tax_regime, email, phone, 
      address, city, state, postal_code, country, credit_days, credit_limit, notes 
    } = req.body;

    const contactId = uuidv4();

    await db.query(
      `INSERT INTO contacts 
       (id, organization_id, type, name, legal_name, rfc, tax_regime, email, phone, address, city, state, postal_code, country, credit_days, credit_limit, notes, created_by) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [contactId, req.organization.id, type, name, legal_name || null, rfc || null, 
       tax_regime || null, email || null, phone || null, address || null, city || null,
       state || null, postal_code || null, country || 'MX', credit_days || 0, 
       credit_limit || null, notes || null, req.user.id]
    );

    res.status(201).json({ id: contactId, name, type });
  } catch (error) {
    next(error);
  }
});

// PUT /api/contacts/:id
router.put('/:id', auth, requireOrg, requireModule('contactos'), async (req, res, next) => {
  try {
    const { 
      type, name, legal_name, rfc, tax_regime, email, phone, 
      address, city, state, postal_code, country, credit_days, credit_limit, notes 
    } = req.body;

    const [result] = await db.query(
      `UPDATE contacts SET 
       type = COALESCE(?, type),
       name = COALESCE(?, name),
       legal_name = COALESCE(?, legal_name),
       rfc = COALESCE(?, rfc),
       tax_regime = COALESCE(?, tax_regime),
       email = COALESCE(?, email),
       phone = COALESCE(?, phone),
       address = COALESCE(?, address),
       city = COALESCE(?, city),
       state = COALESCE(?, state),
       postal_code = COALESCE(?, postal_code),
       country = COALESCE(?, country),
       credit_days = COALESCE(?, credit_days),
       credit_limit = COALESCE(?, credit_limit),
       notes = COALESCE(?, notes)
       WHERE id = ? AND organization_id = ?`,
      [type, name, legal_name, rfc, tax_regime, email, phone, address, city, state, 
       postal_code, country, credit_days, credit_limit, notes, req.params.id, req.organization.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }

    res.json({ message: 'Contacto actualizado' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/contacts/:id
router.delete('/:id', auth, requireOrg, requireModule('contactos'), async (req, res, next) => {
  try {
    const [result] = await db.query(
      'UPDATE contacts SET is_active = 0 WHERE id = ? AND organization_id = ?',
      [req.params.id, req.organization.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }

    res.json({ message: 'Contacto eliminado' });
  } catch (error) {
    next(error);
  }
});

// GET /api/contacts/:id/transactions
router.get('/:id/transactions', auth, requireOrg, async (req, res, next) => {
  try {
    const { type, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let results = [];

    if (!type || type === 'sales') {
      const [sales] = await db.query(
        `SELECT 'sale' as record_type, s.id, s.sale_number as number, s.date, s.total, s.paid_amount, s.payment_status
         FROM sales s WHERE s.contact_id = ? AND s.organization_id = ?
         ORDER BY s.date DESC LIMIT ? OFFSET ?`,
        [req.params.id, req.organization.id, parseInt(limit), offset]
      );
      results = results.concat(sales);
    }

    if (!type || type === 'expenses') {
      const [expenses] = await db.query(
        `SELECT 'expense' as record_type, e.id, e.expense_number as number, e.date, e.total, e.paid_amount, e.payment_status
         FROM expenses e WHERE e.contact_id = ? AND e.organization_id = ?
         ORDER BY e.date DESC LIMIT ? OFFSET ?`,
        [req.params.id, req.organization.id, parseInt(limit), offset]
      );
      results = results.concat(expenses);
    }

    // Sort by date
    results.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json(results);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
