const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth, requireOrg, requireModule } = require('../middlewares/auth.middleware');

// GET /api/sales
router.get('/', auth, requireOrg, requireModule('ventas'), async (req, res, next) => {
  try {
    const { 
      contact_id, status, start_date, end_date, 
      search, page = 1, limit = 50 
    } = req.query;

    let sql = `
      SELECT s.*, c.name as contact_name, c.rfc as contact_rfc
      FROM sales s
      LEFT JOIN contacts c ON c.id = s.contact_id
      WHERE s.organization_id = ?
    `;
    const params = [req.organization.id];

    if (contact_id) {
      sql += ' AND s.contact_id = ?';
      params.push(contact_id);
    }
    if (status) {
      sql += ' AND s.payment_status = ?';
      params.push(status);
    }
    if (start_date) {
      sql += ' AND s.date >= ?';
      params.push(start_date);
    }
    if (end_date) {
      sql += ' AND s.date <= ?';
      params.push(end_date);
    }
    if (search) {
      sql += ' AND (s.sale_number LIKE ? OR s.cfdi_uuid LIKE ? OR c.name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const countSql = sql.replace(/SELECT .* FROM/, 'SELECT COUNT(*) as total FROM');
    const [[{ total }]] = await db.query(countSql, params);

    const offset = (parseInt(page) - 1) * parseInt(limit);
    sql += ' ORDER BY s.date DESC, s.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const [sales] = await db.query(sql, params);

    res.json({
      sales,
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

// GET /api/sales/:id
router.get('/:id', auth, requireOrg, requireModule('ventas'), async (req, res, next) => {
  try {
    const [sales] = await db.query(
      `SELECT s.*, c.name as contact_name, c.rfc as contact_rfc, c.email as contact_email
       FROM sales s
       LEFT JOIN contacts c ON c.id = s.contact_id
       WHERE s.id = ? AND s.organization_id = ?`,
      [req.params.id, req.organization.id]
    );

    if (!sales.length) {
      return res.status(404).json({ error: 'Venta no encontrada' });
    }

    // Items
    const [items] = await db.query(
      'SELECT * FROM sale_items WHERE sale_id = ?',
      [req.params.id]
    );

    // Pagos
    const [payments] = await db.query(
      `SELECT p.*, bt.bank_account_id, ba.name as account_name
       FROM payments p
       LEFT JOIN bank_transactions bt ON bt.id = p.bank_transaction_id
       LEFT JOIN bank_accounts ba ON ba.id = bt.bank_account_id
       WHERE p.sale_id = ?
       ORDER BY p.date DESC`,
      [req.params.id]
    );

    // Schedule
    const [schedule] = await db.query(
      'SELECT * FROM payment_schedules WHERE sale_id = ? ORDER BY due_date',
      [req.params.id]
    );

    res.json({
      ...sales[0],
      items,
      payments,
      schedule
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/sales
router.post('/', auth, requireOrg, requireModule('ventas'), [
  body('date').isDate(),
  body('items').isArray({ min: 1 })
], async (req, res, next) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { 
      contact_id, sale_number, date, due_date, items, 
      currency, exchange_rate, notes, cfdi_uuid, cfdi_folio, cfdi_serie,
      xml_file_url, pdf_file_url
    } = req.body;

    const saleId = uuidv4();

    // Calcular totales de items
    let subtotal = 0;
    let tax = 0;
    let discount = 0;

    for (const item of items) {
      const itemSubtotal = item.quantity * item.unit_price;
      const itemDiscount = item.discount || 0;
      const itemTax = (itemSubtotal - itemDiscount) * (item.tax_rate || 16) / 100;
      
      subtotal += itemSubtotal;
      discount += itemDiscount;
      tax += itemTax;
    }

    const total = subtotal - discount + tax;

    await connection.query(
      `INSERT INTO sales 
       (id, organization_id, contact_id, sale_number, date, due_date, cfdi_uuid, cfdi_folio, cfdi_serie,
        subtotal, tax, discount, total, currency, exchange_rate, notes, xml_file_url, pdf_file_url, created_by) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [saleId, req.organization.id, contact_id || null, sale_number || null, date, due_date || null,
       cfdi_uuid || null, cfdi_folio || null, cfdi_serie || null, subtotal, tax, discount, total,
       currency || 'MXN', exchange_rate || 1, notes || null, xml_file_url || null, pdf_file_url || null, req.user.id]
    );

    // Insertar items
    for (const item of items) {
      const itemSubtotal = item.quantity * item.unit_price - (item.discount || 0);
      const itemTax = itemSubtotal * (item.tax_rate || 16) / 100;

      await connection.query(
        `INSERT INTO sale_items 
         (id, sale_id, product_code, description, quantity, unit_price, discount, tax_rate, subtotal, tax, total) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), saleId, item.product_code || null, item.description, item.quantity, 
         item.unit_price, item.discount || 0, item.tax_rate || 16, itemSubtotal, itemTax, itemSubtotal + itemTax]
      );
    }

    await connection.commit();
    res.status(201).json({ id: saleId, total });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// PUT /api/sales/:id
router.put('/:id', auth, requireOrg, requireModule('ventas'), async (req, res, next) => {
  try {
    const { 
      contact_id, sale_number, date, due_date, notes,
      cfdi_uuid, cfdi_folio, cfdi_serie, xml_file_url, pdf_file_url
    } = req.body;

    const [result] = await db.query(
      `UPDATE sales SET 
       contact_id = COALESCE(?, contact_id),
       sale_number = COALESCE(?, sale_number),
       date = COALESCE(?, date),
       due_date = COALESCE(?, due_date),
       notes = COALESCE(?, notes),
       cfdi_uuid = COALESCE(?, cfdi_uuid),
       cfdi_folio = COALESCE(?, cfdi_folio),
       cfdi_serie = COALESCE(?, cfdi_serie),
       xml_file_url = COALESCE(?, xml_file_url),
       pdf_file_url = COALESCE(?, pdf_file_url)
       WHERE id = ? AND organization_id = ?`,
      [contact_id, sale_number, date, due_date, notes, cfdi_uuid, cfdi_folio, cfdi_serie,
       xml_file_url, pdf_file_url, req.params.id, req.organization.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Venta no encontrada' });
    }

    res.json({ message: 'Venta actualizada' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/sales/:id
router.delete('/:id', auth, requireOrg, requireModule('ventas'), async (req, res, next) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [sales] = await connection.query(
      'SELECT paid_amount FROM sales WHERE id = ? AND organization_id = ?',
      [req.params.id, req.organization.id]
    );

    if (!sales.length) {
      return res.status(404).json({ error: 'Venta no encontrada' });
    }

    if (parseFloat(sales[0].paid_amount) > 0) {
      return res.status(400).json({ error: 'No se puede eliminar una venta con pagos registrados' });
    }

    // Desvincular transacciones
    await connection.query(
      'UPDATE bank_transactions SET linked_sale_id = NULL WHERE linked_sale_id = ?',
      [req.params.id]
    );

    await connection.query('DELETE FROM sale_items WHERE sale_id = ?', [req.params.id]);
    await connection.query('DELETE FROM payment_schedules WHERE sale_id = ?', [req.params.id]);
    await connection.query('DELETE FROM sales WHERE id = ?', [req.params.id]);

    await connection.commit();
    res.json({ message: 'Venta eliminada' });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// POST /api/sales/:id/schedule - Crear programación de pagos
router.post('/:id/schedule', auth, requireOrg, requireModule('ventas'), [
  body('installments').isArray({ min: 1 })
], async (req, res, next) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const { installments } = req.body;

    const [sales] = await connection.query(
      'SELECT total, paid_amount FROM sales WHERE id = ? AND organization_id = ?',
      [req.params.id, req.organization.id]
    );

    if (!sales.length) {
      return res.status(404).json({ error: 'Venta no encontrada' });
    }

    const pending = parseFloat(sales[0].total) - parseFloat(sales[0].paid_amount);
    const totalScheduled = installments.reduce((sum, i) => sum + parseFloat(i.amount), 0);

    if (Math.abs(totalScheduled - pending) > 0.01) {
      return res.status(400).json({ 
        error: 'La suma de parcialidades debe ser igual al saldo pendiente',
        pending,
        scheduled: totalScheduled
      });
    }

    // Eliminar schedule existente
    await connection.query('DELETE FROM payment_schedules WHERE sale_id = ?', [req.params.id]);

    // Crear nuevos
    for (let i = 0; i < installments.length; i++) {
      await connection.query(
        `INSERT INTO payment_schedules 
         (id, organization_id, sale_id, installment_number, due_date, amount) 
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

module.exports = router;
