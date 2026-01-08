const router = require('express').Router();
const db = require('../config/database');
const { auth, requireOrg, requireModule } = require('../middlewares/auth.middleware');

// GET /api/reports/dashboard - Dashboard principal (paralelo)
router.get('/dashboard', auth, requireOrg, async (req, res, next) => {
  try {
    const { period = 'month' } = req.query;
    const orgId = req.organization.id;

    let dateFilter;
    switch (period) {
      case 'week':
        dateFilter = 'date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
        break;
      case 'month':
        dateFilter = 'date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)';
        break;
      case 'quarter':
        dateFilter = 'date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)';
        break;
      case 'year':
        dateFilter = 'date >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)';
        break;
      default:
        dateFilter = 'date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)';
    }

    // Ejecutar todas las queries en paralelo
    const [
      [balances],
      [ingresos],
      [egresos],
      [pendingReceivable],
      [pendingPayable],
      [recentTransactions],
      [topCategories]
    ] = await Promise.all([
      // Balance total de cuentas
      db.query(
        `SELECT SUM(current_balance) as total_balance 
         FROM bank_accounts WHERE organization_id = ? AND is_active = 1`,
        [orgId]
      ),
      // Ingresos del período
      db.query(
        `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
         FROM bank_transactions 
         WHERE organization_id = ? AND type = 'ingreso' AND ${dateFilter}`,
        [orgId]
      ),
      // Egresos del período
      db.query(
        `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
         FROM bank_transactions 
         WHERE organization_id = ? AND type = 'egreso' AND ${dateFilter}`,
        [orgId]
      ),
      // Por cobrar
      db.query(
        `SELECT COALESCE(SUM(total - paid_amount), 0) as total, COUNT(*) as count
         FROM sales 
         WHERE organization_id = ? AND payment_status IN ('pendiente', 'parcial')`,
        [orgId]
      ),
      // Por pagar
      db.query(
        `SELECT COALESCE(SUM(total - paid_amount), 0) as total, COUNT(*) as count
         FROM expenses 
         WHERE organization_id = ? AND payment_status IN ('pendiente', 'parcial')`,
        [orgId]
      ),
      // Transacciones recientes
      db.query(
        `SELECT bt.id, bt.type, bt.amount, bt.date, bt.description, ba.name as account_name
         FROM bank_transactions bt
         JOIN bank_accounts ba ON ba.id = bt.bank_account_id
         WHERE bt.organization_id = ?
         ORDER BY bt.date DESC, bt.created_at DESC
         LIMIT 10`,
        [orgId]
      ),
      // Top categorías
      db.query(
        `SELECT category, type, SUM(amount) as total, COUNT(*) as count
         FROM bank_transactions
         WHERE organization_id = ? AND category IS NOT NULL AND ${dateFilter}
         GROUP BY category, type
         ORDER BY total DESC
         LIMIT 10`,
        [orgId]
      )
    ]);

    const totalIngresos = parseFloat(ingresos[0]?.total) || 0;
    const totalEgresos = parseFloat(egresos[0]?.total) || 0;

    res.json({
      period,
      balance: {
        total: parseFloat(balances[0]?.total_balance) || 0
      },
      cashflow: {
        ingresos: totalIngresos,
        egresos: totalEgresos,
        neto: totalIngresos - totalEgresos,
        ingresos_count: ingresos[0]?.count || 0,
        egresos_count: egresos[0]?.count || 0
      },
      pending: {
        receivable: parseFloat(pendingReceivable[0]?.total) || 0,
        receivable_count: pendingReceivable[0]?.count || 0,
        payable: parseFloat(pendingPayable[0]?.total) || 0,
        payable_count: pendingPayable[0]?.count || 0
      },
      recent_transactions: recentTransactions,
      top_categories: topCategories
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/reports/cashflow - Flujo de efectivo por período
router.get('/cashflow', auth, requireOrg, requireModule('reportes'), async (req, res, next) => {
  try {
    const { start_date, end_date, group_by = 'day' } = req.query;
    const orgId = req.organization.id;

    let dateFormat, interval;
    switch (group_by) {
      case 'week':
        dateFormat = '%Y-%u';
        interval = 'WEEK';
        break;
      case 'month':
        dateFormat = '%Y-%m';
        interval = 'MONTH';
        break;
      default:
        dateFormat = '%Y-%m-%d';
        interval = 'DAY';
    }

    const startDate = start_date || 'DATE_SUB(CURDATE(), INTERVAL 30 DAY)';
    const endDate = end_date || 'CURDATE()';

    const [data] = await db.query(
      `SELECT 
         DATE_FORMAT(date, '${dateFormat}') as period,
         SUM(CASE WHEN type = 'ingreso' THEN amount ELSE 0 END) as ingresos,
         SUM(CASE WHEN type = 'egreso' THEN amount ELSE 0 END) as egresos
       FROM bank_transactions
       WHERE organization_id = ?
       AND date >= ${start_date ? '?' : startDate}
       AND date <= ${end_date ? '?' : endDate}
       GROUP BY period
       ORDER BY period`,
      [orgId, ...(start_date ? [start_date] : []), ...(end_date ? [end_date] : [])]
    );

    // Calcular acumulados
    let balance = 0;
    const dataWithBalance = data.map(row => {
      balance += (parseFloat(row.ingresos) || 0) - (parseFloat(row.egresos) || 0);
      return {
        ...row,
        ingresos: parseFloat(row.ingresos) || 0,
        egresos: parseFloat(row.egresos) || 0,
        neto: (parseFloat(row.ingresos) || 0) - (parseFloat(row.egresos) || 0),
        balance_acumulado: balance
      };
    });

    res.json({
      group_by,
      data: dataWithBalance,
      totals: {
        ingresos: data.reduce((sum, r) => sum + (parseFloat(r.ingresos) || 0), 0),
        egresos: data.reduce((sum, r) => sum + (parseFloat(r.egresos) || 0), 0)
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/reports/profit-loss - Estado de resultados
router.get('/profit-loss', auth, requireOrg, requireModule('reportes'), async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;
    const orgId = req.organization.id;

    const dateCondition = start_date && end_date 
      ? 'AND date BETWEEN ? AND ?' 
      : 'AND date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)';
    const params = start_date && end_date 
      ? [orgId, start_date, end_date] 
      : [orgId];

    const [
      [ingresosByCategory],
      [egresosByCategory],
      [salesTotal],
      [expensesTotal]
    ] = await Promise.all([
      db.query(
        `SELECT COALESCE(category, 'Sin categoría') as category, SUM(amount) as total
         FROM bank_transactions
         WHERE organization_id = ? AND type = 'ingreso' ${dateCondition}
         GROUP BY category
         ORDER BY total DESC`,
        params
      ),
      db.query(
        `SELECT COALESCE(category, 'Sin categoría') as category, SUM(amount) as total
         FROM bank_transactions
         WHERE organization_id = ? AND type = 'egreso' ${dateCondition}
         GROUP BY category
         ORDER BY total DESC`,
        params
      ),
      db.query(
        `SELECT COALESCE(SUM(total), 0) as total FROM sales 
         WHERE organization_id = ? ${dateCondition.replace('date', 'sales.date')}`,
        params
      ),
      db.query(
        `SELECT COALESCE(SUM(total), 0) as total FROM expenses 
         WHERE organization_id = ? ${dateCondition.replace('date', 'expenses.date')}`,
        params
      )
    ]);

    const totalIngresos = ingresosByCategory.reduce((sum, r) => sum + parseFloat(r.total), 0);
    const totalEgresos = egresosByCategory.reduce((sum, r) => sum + parseFloat(r.total), 0);

    res.json({
      ingresos: {
        total: totalIngresos,
        by_category: ingresosByCategory
      },
      egresos: {
        total: totalEgresos,
        by_category: egresosByCategory
      },
      utilidad_neta: totalIngresos - totalEgresos,
      ventas_facturadas: parseFloat(salesTotal[0]?.total) || 0,
      gastos_facturados: parseFloat(expensesTotal[0]?.total) || 0
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/reports/accounts-summary - Resumen de cuentas
router.get('/accounts-summary', auth, requireOrg, requireModule('bancos'), async (req, res, next) => {
  try {
    const orgId = req.organization.id;

    const [accounts] = await db.query(
      `SELECT ba.id, ba.name, ba.bank_name, ba.currency, ba.current_balance,
              (SELECT COUNT(*) FROM bank_transactions WHERE bank_account_id = ba.id) as transaction_count,
              (SELECT SUM(CASE WHEN type = 'ingreso' THEN amount ELSE 0 END) 
               FROM bank_transactions WHERE bank_account_id = ba.id AND date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) as month_ingresos,
              (SELECT SUM(CASE WHEN type = 'egreso' THEN amount ELSE 0 END) 
               FROM bank_transactions WHERE bank_account_id = ba.id AND date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) as month_egresos
       FROM bank_accounts ba
       WHERE ba.organization_id = ? AND ba.is_active = 1
       ORDER BY ba.current_balance DESC`,
      [orgId]
    );

    res.json({
      accounts: accounts.map(a => ({
        ...a,
        current_balance: parseFloat(a.current_balance) || 0,
        month_ingresos: parseFloat(a.month_ingresos) || 0,
        month_egresos: parseFloat(a.month_egresos) || 0,
        month_neto: (parseFloat(a.month_ingresos) || 0) - (parseFloat(a.month_egresos) || 0)
      })),
      total_balance: accounts.reduce((sum, a) => sum + (parseFloat(a.current_balance) || 0), 0)
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/reports/aging - Antigüedad de saldos
router.get('/aging', auth, requireOrg, requireModule('reportes'), async (req, res, next) => {
  try {
    const { type = 'both' } = req.query;
    const orgId = req.organization.id;

    const results = {};

    if (type === 'receivable' || type === 'both') {
      const [receivable] = await db.query(
        `SELECT 
           CASE 
             WHEN due_date IS NULL THEN 'Sin vencimiento'
             WHEN DATEDIFF(CURDATE(), due_date) < 0 THEN 'Vigente'
             WHEN DATEDIFF(CURDATE(), due_date) BETWEEN 0 AND 30 THEN '1-30 días'
             WHEN DATEDIFF(CURDATE(), due_date) BETWEEN 31 AND 60 THEN '31-60 días'
             WHEN DATEDIFF(CURDATE(), due_date) BETWEEN 61 AND 90 THEN '61-90 días'
             ELSE '+90 días'
           END as aging_bucket,
           COUNT(*) as count,
           SUM(total - paid_amount) as total
         FROM sales
         WHERE organization_id = ? AND payment_status IN ('pendiente', 'parcial')
         GROUP BY aging_bucket`,
        [orgId]
      );
      results.receivable = receivable;
    }

    if (type === 'payable' || type === 'both') {
      const [payable] = await db.query(
        `SELECT 
           CASE 
             WHEN due_date IS NULL THEN 'Sin vencimiento'
             WHEN DATEDIFF(CURDATE(), due_date) < 0 THEN 'Vigente'
             WHEN DATEDIFF(CURDATE(), due_date) BETWEEN 0 AND 30 THEN '1-30 días'
             WHEN DATEDIFF(CURDATE(), due_date) BETWEEN 31 AND 60 THEN '31-60 días'
             WHEN DATEDIFF(CURDATE(), due_date) BETWEEN 61 AND 90 THEN '61-90 días'
             ELSE '+90 días'
           END as aging_bucket,
           COUNT(*) as count,
           SUM(total - paid_amount) as total
         FROM expenses
         WHERE organization_id = ? AND payment_status IN ('pendiente', 'parcial')
         GROUP BY aging_bucket`,
        [orgId]
      );
      results.payable = payable;
    }

    res.json(results);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
