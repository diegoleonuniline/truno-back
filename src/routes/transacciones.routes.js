const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { auth, requireOrg } = require('../middlewares/auth.middleware');

// GET /api/transacciones/plataformas/saldos
// Devuelve saldo por plataforma (Dinero en Plataforma) calculado como:
// SUM(monto) de ingresos con estado_operacion = 'en_transito' agrupados por plataforma_origen.
//
// Relación:
// - truno-front/bancos/index.html + bancos.js -> muestra tarjetas por plataforma
// - truno-front/transacciones -> el usuario setea estado_operacion y plataforma_origen
// - truno-back/src/db/migrate.js -> ensureEstadoOperacionColumn()
router.get('/plataformas/saldos', auth, requireOrg, async (req, res, next) => {
  try {
    const orgId = req.organizacion.id;
    const [rows] = await db.query(
      `SELECT plataforma_origen, COALESCE(SUM(monto), 0) AS total
       FROM transacciones
       WHERE organizacion_id = ?
         AND tipo = 'ingreso'
         AND estado_operacion = 'en_transito'
         AND plataforma_origen IS NOT NULL
         AND plataforma_origen <> ''
       GROUP BY plataforma_origen
       ORDER BY total DESC`,
      [orgId]
    );

    res.json({
      plataformas: (rows || []).map(r => ({
        plataforma_origen: r.plataforma_origen,
        total: parseFloat(r.total) || 0
      }))
    });
  } catch (err) {
    // Compatibilidad: si la instalación no tiene la columna aún (o no hay permisos de ALTER),
    // devolvemos vacío para no romper la UI.
    if (err && err.code === 'ER_BAD_FIELD_ERROR') {
      return res.json({ plataformas: [] });
    }
    next(err);
  }
});

// GET /api/transacciones
router.get('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { 
      cuenta_bancaria_id, contacto_id, tipo, buscar, sin_conciliar, conciliado,
      // Filtros adicionales:
      // - excluir_transferencias=1 -> oculta transferencias internas en la vista de Transacciones
      // - solo_transferencias=1 -> devuelve únicamente transferencias internas (útil para módulo Transferencias)
      excluir_transferencias, solo_transferencias,
      pagina = 1, limite = 20 
    } = req.query;

    let sql = `
      SELECT t.*, cb.nombre as nombre_cuenta, c.nombre as nombre_contacto
      FROM transacciones t
      LEFT JOIN cuentas_bancarias cb ON cb.id = t.cuenta_bancaria_id
      LEFT JOIN contactos c ON c.id = t.contacto_id
      WHERE t.organizacion_id = ?
    `;
    const params = [req.organizacion.id];

    if (cuenta_bancaria_id) {
      sql += ' AND t.cuenta_bancaria_id = ?';
      params.push(cuenta_bancaria_id);
    }
    if (contacto_id) {
      sql += ' AND t.contacto_id = ?';
      params.push(contacto_id);
    }
    if (tipo) {
      sql += ' AND t.tipo = ?';
      params.push(tipo);
    }
    if (sin_conciliar === '1') {
      sql += ' AND t.gasto_id IS NULL AND t.venta_id IS NULL';
    }
    if (conciliado === '1') {
      sql += ' AND (t.gasto_id IS NOT NULL OR t.venta_id IS NOT NULL)';
    }
    // Transferencias internas (misma tabla)
    // Relacionado con:
    // - truno-front/transacciones/transacciones.js (excluir_transferencias=1 para que el filtro "Estado" sea correcto)
    // - truno-front/transferencias/transferencias.js (solo_transferencias=1 si se desea optimizar)
    if (solo_transferencias === '1') {
      sql += ' AND t.es_transferencia_interna = 1';
    } else if (excluir_transferencias === '1') {
      sql += ' AND (t.es_transferencia_interna IS NULL OR t.es_transferencia_interna = 0)';
    }
    if (buscar) {
      sql += ' AND (t.descripcion LIKE ? OR t.referencia LIKE ?)';
      params.push(`%${buscar}%`, `%${buscar}%`);
    }

    const countSql = sql.replace(/SELECT t\.\*.*FROM/s, 'SELECT COUNT(*) as total FROM');
    const [[{ total }]] = await db.query(countSql, params);

    const offset = (parseInt(pagina) - 1) * parseInt(limite);
    sql += ' ORDER BY t.fecha DESC, t.creado_en DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limite), offset);

    const [transacciones] = await db.query(sql, params);

    res.json({
      transacciones,
      paginacion: {
        total,
        pagina: parseInt(pagina),
        limite: parseInt(limite),
        paginas: Math.ceil(total / parseInt(limite))
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/transacciones/:id
router.get('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    const [transacciones] = await db.query(
      `SELECT t.*, cb.nombre as nombre_cuenta
       FROM transacciones t
       LEFT JOIN cuentas_bancarias cb ON cb.id = t.cuenta_bancaria_id
       WHERE t.id = ? AND t.organizacion_id = ?`,
      [req.params.id, req.organizacion.id]
    );

    if (!transacciones.length) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    res.json(transacciones[0]);
  } catch (error) {
    next(error);
  }
});

// POST /api/transacciones
// POST /api/transacciones - reemplaza el actual
router.post('/', auth, requireOrg, async (req, res, next) => {
  try {
    const { 
      cuenta_bancaria_id, tipo, monto, fecha, contacto_id,
      descripcion, referencia, comprobante_url,
      moneda, metodo_pago,
      plataforma_origen, monto_bruto, moneda_origen, tipo_comision, comision_valor, tipo_cambio,
      gasto_id, venta_id,
      // Estado operativo (tracking) - solicitado por negocio
      // Valores normalizados:
      // - en_transito | realizado | cancelado
      // Relación:
      // - truno-front/transacciones/index.html (#estadoOperacion)
      // - truno-front/transacciones/transacciones.js -> submitTx() envía estado_operacion (solo ingresos)
      estado_operacion
    } = req.body;

    if (!cuenta_bancaria_id || !tipo || !fecha) {
      return res.status(400).json({ error: 'Cuenta, tipo y fecha son requeridos' });
    }

    const montoNum = (monto !== undefined && monto !== null && monto !== '') ? parseFloat(monto) : null;
    const montoBrutoNum = (monto_bruto !== undefined && monto_bruto !== null && monto_bruto !== '') ? parseFloat(monto_bruto) : null;
    if (
      (montoBrutoNum === null || Number.isNaN(montoBrutoNum) || montoBrutoNum <= 0) &&
      (montoNum === null || Number.isNaN(montoNum))
    ) {
      return res.status(400).json({ error: 'Monto es requerido (monto o monto_bruto)' });
    }

    // Verificar cuenta
    const [cuentas] = await db.query(
      'SELECT id, saldo_actual FROM cuentas_bancarias WHERE id = ? AND organizacion_id = ?',
      [cuenta_bancaria_id, req.organizacion.id]
    );

    if (!cuentas.length) {
      return res.status(400).json({ error: 'Cuenta bancaria no válida' });
    }

    const transaccionId = uuidv4();
    
    // Calcular monto neto si hay monto_bruto
    let montoFinal;
    if (montoBrutoNum !== null && !Number.isNaN(montoBrutoNum) && montoBrutoNum > 0) {
      const bruto = montoBrutoNum;
      const tipoComision = tipo_comision || 'monto';
      const valorComision = (comision_valor !== undefined && comision_valor !== null && comision_valor !== '')
        ? (parseFloat(comision_valor) || 0)
        : 0;
      const tc = (tipo_cambio !== undefined && tipo_cambio !== null && tipo_cambio !== '')
        ? (parseFloat(tipo_cambio) || 1)
        : 1;
      
      let comisionCalculada = 0;
      if (tipoComision === 'porcentaje') {
        comisionCalculada = bruto * valorComision / 100;
      } else {
        comisionCalculada = valorComision;
      }
      
      montoFinal = (bruto - comisionCalculada) * tc;
    } else {
      montoFinal = montoNum;
    }

    if (!Number.isFinite(montoFinal)) {
      return res.status(400).json({ error: 'Monto inválido' });
    }

    const saldoActual = parseFloat(cuentas[0].saldo_actual);
    const nuevoSaldo = tipo === 'ingreso' ? saldoActual + montoFinal : saldoActual - montoFinal;

    // Estado operativo:
    // - Por regla de negocio, solo se usa para ingresos.
    // - Default: realizado.
    // - Se valida para evitar valores arbitrarios.
    const allowedEstadosOperacion = new Set(['en_transito', 'realizado', 'cancelado']);
    let estadoOperacionFinal = 'realizado';
    if (tipo === 'ingreso') {
      const raw = String(estado_operacion || '').toLowerCase().trim();
      if (allowedEstadosOperacion.has(raw)) estadoOperacionFinal = raw;
    }

    try {
      await db.query(
        `INSERT INTO transacciones 
         (id, organizacion_id, cuenta_bancaria_id, tipo, monto, fecha, contacto_id,
          descripcion, referencia, comprobante_url,
          gasto_id, venta_id,
          metodo_pago, moneda, plataforma_origen, monto_bruto, tipo_comision, 
          comision_valor, moneda_origen, tipo_cambio,
          estado_operacion,
          saldo_despues, creado_por) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          transaccionId, req.organizacion.id, cuenta_bancaria_id, tipo, montoFinal, fecha,
          contacto_id || null, descripcion || null, referencia || null, comprobante_url || null,
          gasto_id || null, venta_id || null,
          metodo_pago || null, moneda || 'MXN',
          plataforma_origen || null,
          (montoBrutoNum !== null && Number.isFinite(montoBrutoNum)) ? montoBrutoNum : null,
          tipo_comision || 'monto',
          (comision_valor !== undefined && comision_valor !== null && comision_valor !== '') ? (parseFloat(comision_valor) || 0) : 0,
          moneda_origen || 'MXN',
          (tipo_cambio !== undefined && tipo_cambio !== null && tipo_cambio !== '') ? (parseFloat(tipo_cambio) || 1) : 1,
          estadoOperacionFinal,
          nuevoSaldo, req.usuario.id
        ]
      );
    } catch (err) {
      if (err && err.code === 'ER_BAD_FIELD_ERROR') {
        // Compatibilidad:
        // 1) Si falta SOLO la columna estado_operacion, intentar INSERT extendido sin ella
        // 2) Si faltan más columnas, caer al INSERT legacy
        console.warn('⚠️ DB sin alguna columna extendida en transacciones. Intentando fallback. Detalle:', err.message);
        try {
          await db.query(
            `INSERT INTO transacciones 
             (id, organizacion_id, cuenta_bancaria_id, tipo, monto, fecha, contacto_id,
              descripcion, referencia, comprobante_url,
              gasto_id, venta_id,
              metodo_pago, moneda, plataforma_origen, monto_bruto, tipo_comision, 
              comision_valor, moneda_origen, tipo_cambio, saldo_despues, creado_por) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              transaccionId, req.organizacion.id, cuenta_bancaria_id, tipo, montoFinal, fecha,
              contacto_id || null, descripcion || null, referencia || null, comprobante_url || null,
              gasto_id || null, venta_id || null,
              metodo_pago || null, moneda || 'MXN',
              plataforma_origen || null,
              (montoBrutoNum !== null && Number.isFinite(montoBrutoNum)) ? montoBrutoNum : null,
              tipo_comision || 'monto',
              (comision_valor !== undefined && comision_valor !== null && comision_valor !== '') ? (parseFloat(comision_valor) || 0) : 0,
              moneda_origen || 'MXN',
              (tipo_cambio !== undefined && tipo_cambio !== null && tipo_cambio !== '') ? (parseFloat(tipo_cambio) || 1) : 1,
              nuevoSaldo, req.usuario.id
            ]
          );
        } catch (err2) {
          if (err2 && err2.code === 'ER_BAD_FIELD_ERROR') {
            console.warn('⚠️ DB sin columnas extendidas de transacciones. Usando INSERT legacy. Detalle:', err2.message);
            await db.query(
              `INSERT INTO transacciones 
               (id, organizacion_id, cuenta_bancaria_id, tipo, monto, fecha, contacto_id,
                descripcion, referencia, comprobante_url, gasto_id, venta_id, 
                saldo_despues, creado_por) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [transaccionId, req.organizacion.id, cuenta_bancaria_id, tipo, montoFinal, fecha,
               contacto_id || null, descripcion || null, referencia || null, comprobante_url || null,
               gasto_id || null, venta_id || null, nuevoSaldo, req.usuario.id]
            );
          } else {
            throw err2;
          }
        }
      } else {
        throw err;
      }
    }

    await db.query('UPDATE cuentas_bancarias SET saldo_actual = ? WHERE id = ?', [nuevoSaldo, cuenta_bancaria_id]);

    // Vincular gasto/venta (código existente)
    if (gasto_id) {
      await db.query(
        'UPDATE gastos SET transaccion_id = ? WHERE id = ? AND organizacion_id = ?', 
        [transaccionId, gasto_id, req.organizacion.id]
      );
    }

    if (venta_id) {
      const [ventas] = await db.query(
        'SELECT id, total, monto_cobrado FROM ventas WHERE id = ? AND organizacion_id = ?',
        [venta_id, req.organizacion.id]
      );
      
      if (ventas.length) {
        const venta = ventas[0];
        const totalVenta = parseFloat(venta.total) || 0;
        // ✅ Negocio (Ventas):
        // La venta debe reflejar lo cobrado SIN descontar comisiones.
        // Ej: venta=1000, banco recibe 800 (fee 200) => monto_cobrado debe sumar 1000.
        // Relación:
        // - truno-front/transacciones: comisiones guardan `monto_bruto`
        // - saldo bancario usa `montoFinal` (neto) para NO inflar el banco
        const montoParaVenta = (montoBrutoNum !== null && Number.isFinite(montoBrutoNum) && montoBrutoNum > 0)
          ? montoBrutoNum
          : montoFinal;
        const nuevoMontoCobrado = (parseFloat(venta.monto_cobrado) || 0) + montoParaVenta;
        let nuevoEstatus = nuevoMontoCobrado >= totalVenta ? 'pagado' : nuevoMontoCobrado > 0 ? 'parcial' : 'pendiente';
        
        await db.query(
          `UPDATE ventas SET transaccion_id = ?, monto_cobrado = ?, estatus_pago = ? WHERE id = ?`,
          [transaccionId, nuevoMontoCobrado, nuevoEstatus, venta_id]
        );
      }
    }

    res.status(201).json({ id: transaccionId, transaccion: { id: transaccionId, monto: montoFinal, saldo_despues: nuevoSaldo } });
  } catch (error) {
    next(error);
  }
});

// PUT /api/transacciones/:id
router.put('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    console.log('✏️ ========== PUT /api/transacciones/:id ==========');
    console.log('📦 Body recibido:', JSON.stringify(req.body, null, 2));
    
    const {
      descripcion, referencia, comprobante_url, contacto_id, gasto_id, venta_id,
      // Campos extendidos (no afectan saldo): permite corregir comisión/moneda/método sin tocar el monto contable
      moneda, metodo_pago,
      plataforma_origen, monto_bruto, moneda_origen, tipo_comision, comision_valor, tipo_cambio,
      // Estado operativo (tracking) - solicitado por negocio
      // Nota: en backend solo aplicamos a ingresos.
      estado_operacion
    } = req.body;

    // Obtener transacción actual
    const [txActual] = await db.query(
      'SELECT * FROM transacciones WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (!txActual.length) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    const tx = txActual[0];
    const montoNum = parseFloat(tx.monto) || 0;
    // ✅ Negocio (Ventas):
    // Para actualizar monto_cobrado de ventas, usar monto_bruto si existe (sin comisión).
    // Mantener `montoNum` (neto) para lógica bancaria/otras referencias.
    const montoVentaNum = (tx.tipo === 'ingreso' && tx.monto_bruto !== null && tx.monto_bruto !== undefined && tx.monto_bruto !== '')
      ? (parseFloat(tx.monto_bruto) || 0)
      : montoNum;
    const oldGastoId = tx.gasto_id;
    const oldVentaId = tx.venta_id;
    const newGastoId = gasto_id !== undefined ? gasto_id : oldGastoId;
    const newVentaId = venta_id !== undefined ? venta_id : oldVentaId;

    // ========== SINCRONIZAR GASTO (bidireccional) ==========
    if (gasto_id !== undefined && gasto_id !== oldGastoId) {
      // Desvincular gasto anterior
      if (oldGastoId) {
        console.log('🔗 Desvinculando gasto anterior:', oldGastoId);
        await db.query('UPDATE gastos SET transaccion_id = NULL WHERE id = ?', [oldGastoId]);
      }
      // Vincular nuevo gasto
      if (newGastoId) {
        console.log('🔗 Vinculando nuevo gasto:', newGastoId);
        await db.query(
          'UPDATE gastos SET transaccion_id = ? WHERE id = ? AND organizacion_id = ?',
          [req.params.id, newGastoId, req.organizacion.id]
        );
      }
    }

    // ========== SINCRONIZAR VENTA (bidireccional) + monto_cobrado ==========
    if (venta_id !== undefined && venta_id !== oldVentaId) {
      // Desvincular venta anterior y restar monto_cobrado
      if (oldVentaId) {
        console.log('🔗 Desvinculando venta anterior:', oldVentaId);
        const [oldVentas] = await db.query(
          'SELECT total, monto_cobrado FROM ventas WHERE id = ?', [oldVentaId]
        );
        if (oldVentas.length) {
          const oldVenta = oldVentas[0];
          const nuevoMontoCobrado = Math.max(0, (parseFloat(oldVenta.monto_cobrado) || 0) - montoVentaNum);
          const totalVenta = parseFloat(oldVenta.total) || 0;
          let nuevoEstatus = 'pendiente';
          if (nuevoMontoCobrado >= totalVenta) nuevoEstatus = 'pagado';
          else if (nuevoMontoCobrado > 0) nuevoEstatus = 'parcial';
          
          await db.query(
            'UPDATE ventas SET transaccion_id = NULL, monto_cobrado = ?, estatus_pago = ? WHERE id = ?',
            [nuevoMontoCobrado, nuevoEstatus, oldVentaId]
          );
        }
      }
      // Vincular nueva venta y sumar monto_cobrado
      if (newVentaId) {
        console.log('🔗 Vinculando nueva venta:', newVentaId);
        const [newVentas] = await db.query(
          'SELECT total, monto_cobrado FROM ventas WHERE id = ? AND organizacion_id = ?',
          [newVentaId, req.organizacion.id]
        );
        if (newVentas.length) {
          const newVenta = newVentas[0];
          const nuevoMontoCobrado = (parseFloat(newVenta.monto_cobrado) || 0) + montoVentaNum;
          const totalVenta = parseFloat(newVenta.total) || 0;
          let nuevoEstatus = 'pendiente';
          if (nuevoMontoCobrado >= totalVenta) nuevoEstatus = 'pagado';
          else if (nuevoMontoCobrado > 0) nuevoEstatus = 'parcial';
          
          await db.query(
            'UPDATE ventas SET transaccion_id = ?, monto_cobrado = ?, estatus_pago = ? WHERE id = ? AND organizacion_id = ?',
            [req.params.id, nuevoMontoCobrado, nuevoEstatus, newVentaId, req.organizacion.id]
          );
        }
      }
    }

    // Actualizar transacción
    let result;
    // Estado operativo:
    // - Solo para ingresos
    // - Si viene un valor inválido, lo ignoramos (no rompemos el update)
    const allowedEstadosOperacion = new Set(['en_transito', 'realizado', 'cancelado']);
    const rawEstadoOp = String(estado_operacion || '').toLowerCase().trim();
    const estadoOperacionToSave = (tx.tipo === 'ingreso' && allowedEstadosOperacion.has(rawEstadoOp)) ? rawEstadoOp : null;
    try {
      ([result] = await db.query(
        `UPDATE transacciones SET 
         descripcion = COALESCE(?, descripcion),
         referencia = ?,
         comprobante_url = ?,
         contacto_id = ?,
         moneda = COALESCE(?, moneda),
         metodo_pago = ?,
         plataforma_origen = ?,
         monto_bruto = ?,
         moneda_origen = ?,
         tipo_comision = ?,
         comision_valor = ?,
         tipo_cambio = ?,
         estado_operacion = COALESCE(?, estado_operacion),
         gasto_id = ?,
         venta_id = ?
         WHERE id = ? AND organizacion_id = ?`,
        [
          descripcion, referencia || null, comprobante_url || null,
          contacto_id || null,
          moneda || null,
          metodo_pago || null,
          plataforma_origen || null,
          monto_bruto !== undefined && monto_bruto !== null && monto_bruto !== '' ? parseFloat(monto_bruto) : null,
          moneda_origen || null,
          tipo_comision || null,
          comision_valor !== undefined && comision_valor !== null && comision_valor !== '' ? parseFloat(comision_valor) : null,
          tipo_cambio !== undefined && tipo_cambio !== null && tipo_cambio !== '' ? parseFloat(tipo_cambio) : null,
          estadoOperacionToSave,
          newGastoId || null, newVentaId || null,
          req.params.id, req.organizacion.id
        ]
      ));
    } catch (err) {
      if (err && err.code === 'ER_BAD_FIELD_ERROR') {
        // Compatibilidad:
        // 1) Intentar UPDATE extendido sin estado_operacion (por si solo falta esa columna)
        // 2) Si siguen faltando columnas, caer al UPDATE legacy
        console.warn('⚠️ DB sin alguna columna extendida en transacciones. Intentando fallback. Detalle:', err.message);
        try {
          ([result] = await db.query(
            `UPDATE transacciones SET 
             descripcion = COALESCE(?, descripcion),
             referencia = ?,
             comprobante_url = ?,
             contacto_id = ?,
             moneda = COALESCE(?, moneda),
             metodo_pago = ?,
             plataforma_origen = ?,
             monto_bruto = ?,
             moneda_origen = ?,
             tipo_comision = ?,
             comision_valor = ?,
             tipo_cambio = ?,
             gasto_id = ?,
             venta_id = ?
             WHERE id = ? AND organizacion_id = ?`,
            [
              descripcion, referencia || null, comprobante_url || null,
              contacto_id || null,
              moneda || null,
              metodo_pago || null,
              plataforma_origen || null,
              monto_bruto !== undefined && monto_bruto !== null && monto_bruto !== '' ? parseFloat(monto_bruto) : null,
              moneda_origen || null,
              tipo_comision || null,
              comision_valor !== undefined && comision_valor !== null && comision_valor !== '' ? parseFloat(comision_valor) : null,
              tipo_cambio !== undefined && tipo_cambio !== null && tipo_cambio !== '' ? parseFloat(tipo_cambio) : null,
              newGastoId || null, newVentaId || null,
              req.params.id, req.organizacion.id
            ]
          ));
        } catch (err2) {
          if (err2 && err2.code === 'ER_BAD_FIELD_ERROR') {
            console.warn('⚠️ DB sin columnas extendidas en transacciones. Usando UPDATE legacy. Detalle:', err2.message);
            ([result] = await db.query(
              `UPDATE transacciones SET 
               descripcion = COALESCE(?, descripcion),
               referencia = ?,
               comprobante_url = ?,
               contacto_id = ?,
               gasto_id = ?,
               venta_id = ?
               WHERE id = ? AND organizacion_id = ?`,
              [descripcion, referencia || null, comprobante_url || null,
               contacto_id || null, newGastoId || null, newVentaId || null,
               req.params.id, req.organizacion.id]
            ));
          } else {
            throw err2;
          }
        }
      } else {
        throw err;
      }
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    res.json({ mensaje: 'Transacción actualizada' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/transacciones/:id
router.delete('/:id', auth, requireOrg, async (req, res, next) => {
  try {
    console.log('🗑️ ========== DELETE /api/transacciones/:id ==========');
    
    // Obtener transacción
    const [trans] = await db.query(
      'SELECT * FROM transacciones WHERE id = ? AND organizacion_id = ?',
      [req.params.id, req.organizacion.id]
    );

    if (!trans.length) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    const tx = trans[0];
    const montoNum = parseFloat(tx.monto) || 0;
    // ✅ Negocio (Ventas):
    // Si la transacción estaba vinculada a una venta, revertir el monto cobrado usando bruto si existe.
    const montoVentaNum = (tx.tipo === 'ingreso' && tx.monto_bruto !== null && tx.monto_bruto !== undefined && tx.monto_bruto !== '')
      ? (parseFloat(tx.monto_bruto) || 0)
      : montoNum;

    // Revertir saldo de cuenta
    const ajuste = tx.tipo === 'ingreso' ? -montoNum : montoNum;
    await db.query('UPDATE cuentas_bancarias SET saldo_actual = saldo_actual + ? WHERE id = ?', 
      [ajuste, tx.cuenta_bancaria_id]);

    // Limpiar referencia en gasto si existe
    if (tx.gasto_id) {
      console.log('🔗 Desvinculando gasto:', tx.gasto_id);
      await db.query('UPDATE gastos SET transaccion_id = NULL WHERE id = ?', [tx.gasto_id]);
    }

    // Limpiar referencia en venta y restar monto_cobrado
    if (tx.venta_id) {
      console.log('🔗 Desvinculando venta:', tx.venta_id);
      const [ventas] = await db.query(
        'SELECT total, monto_cobrado FROM ventas WHERE id = ?', [tx.venta_id]
      );
      if (ventas.length) {
        const venta = ventas[0];
        const nuevoMontoCobrado = Math.max(0, (parseFloat(venta.monto_cobrado) || 0) - montoVentaNum);
        const totalVenta = parseFloat(venta.total) || 0;
        let nuevoEstatus = 'pendiente';
        if (nuevoMontoCobrado >= totalVenta) nuevoEstatus = 'pagado';
        else if (nuevoMontoCobrado > 0) nuevoEstatus = 'parcial';
        
        await db.query(
          'UPDATE ventas SET transaccion_id = NULL, monto_cobrado = ?, estatus_pago = ? WHERE id = ?',
          [nuevoMontoCobrado, nuevoEstatus, tx.venta_id]
        );
        console.log('💰 Venta actualizada - Nuevo monto_cobrado:', nuevoMontoCobrado, 'Estatus:', nuevoEstatus);
      }
    }

    // Eliminar transacción
    await db.query('DELETE FROM transacciones WHERE id = ?', [req.params.id]);

    res.json({ mensaje: 'Transacción eliminada' });
  } catch (error) {
    next(error);
  }
});
// POST /api/transacciones/transferencia
router.post('/transferencia', auth, requireOrg, async (req, res, next) => {
  try {
    console.log('🔄 ========== POST /api/transacciones/transferencia ==========');
    
    const { cuenta_origen_id, cuenta_destino_id, monto, fecha, descripcion, referencia, estado_transferencia } = req.body;

    if (!cuenta_origen_id || !cuenta_destino_id || !monto || !fecha) {
      return res.status(400).json({ error: 'Faltan datos requeridos' });
    }

    if (cuenta_origen_id === cuenta_destino_id) {
      return res.status(400).json({ error: 'Las cuentas deben ser diferentes' });
    }

    const montoNum = parseFloat(monto);
    if (montoNum <= 0) {
      return res.status(400).json({ error: 'El monto debe ser mayor a 0' });
    }

    // Estado (tracking) de la transferencia
    // Relacionado con: truno-front/transferencias/transferencias.js (columna Estado)
    const allowedEstados = new Set(['recibido', 'en_transito', 'en_cuenta']);
    const estadoFinal = allowedEstados.has(String(estado_transferencia || '').toLowerCase())
      ? String(estado_transferencia).toLowerCase()
      : 'en_cuenta';

    // Verificar saldo de cuenta origen
    const [cuentaOrigen] = await db.query(
      'SELECT saldo_actual FROM cuentas_bancarias WHERE id = ? AND organizacion_id = ?',
      [cuenta_origen_id, req.organizacion.id]
    );

    if (!cuentaOrigen.length) {
      return res.status(404).json({ error: 'Cuenta origen no encontrada' });
    }

    const saldoOrigen = parseFloat(cuentaOrigen[0].saldo_actual) || 0;
    if (montoNum > saldoOrigen) {
      return res.status(400).json({ error: 'Saldo insuficiente en cuenta origen' });
    }

    // Verificar cuenta destino existe
    const [cuentaDestino] = await db.query(
      'SELECT saldo_actual FROM cuentas_bancarias WHERE id = ? AND organizacion_id = ?',
      [cuenta_destino_id, req.organizacion.id]
    );

    if (!cuentaDestino.length) {
      return res.status(404).json({ error: 'Cuenta destino no encontrada' });
    }

    const saldoDestino = parseFloat(cuentaDestino[0].saldo_actual) || 0;

    // Crear IDs
    const egresoId = uuidv4();
    const ingresoId = uuidv4();
    const desc = descripcion || 'Transferencia entre cuentas';

    // Crear egreso (cuenta origen)
    try {
      await db.query(
        `INSERT INTO transacciones 
         (id, organizacion_id, cuenta_bancaria_id, tipo, monto, fecha, descripcion, referencia, 
          es_transferencia_interna, id_par_transferencia, estado_transferencia, saldo_despues, creado_por)
         VALUES (?, ?, ?, 'egreso', ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [egresoId, req.organizacion.id, cuenta_origen_id, montoNum, fecha, desc, referencia || null,
         ingresoId, estadoFinal, saldoOrigen - montoNum, req.usuario.id]
      );
    } catch (err) {
      // Compatibilidad: si la columna no existe aún
      if (err && err.code === 'ER_BAD_FIELD_ERROR') {
        await db.query(
          `INSERT INTO transacciones 
           (id, organizacion_id, cuenta_bancaria_id, tipo, monto, fecha, descripcion, referencia, 
            es_transferencia_interna, id_par_transferencia, saldo_despues, creado_por)
           VALUES (?, ?, ?, 'egreso', ?, ?, ?, ?, 1, ?, ?, ?)`,
          [egresoId, req.organizacion.id, cuenta_origen_id, montoNum, fecha, desc, referencia || null,
           ingresoId, saldoOrigen - montoNum, req.usuario.id]
        );
      } else {
        throw err;
      }
    }

    // Crear ingreso (cuenta destino)
    try {
      await db.query(
        `INSERT INTO transacciones 
         (id, organizacion_id, cuenta_bancaria_id, tipo, monto, fecha, descripcion, referencia,
          es_transferencia_interna, id_par_transferencia, estado_transferencia, saldo_despues, creado_por)
         VALUES (?, ?, ?, 'ingreso', ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [ingresoId, req.organizacion.id, cuenta_destino_id, montoNum, fecha, desc, referencia || null,
         egresoId, estadoFinal, saldoDestino + montoNum, req.usuario.id]
      );
    } catch (err) {
      if (err && err.code === 'ER_BAD_FIELD_ERROR') {
        await db.query(
          `INSERT INTO transacciones 
           (id, organizacion_id, cuenta_bancaria_id, tipo, monto, fecha, descripcion, referencia,
            es_transferencia_interna, id_par_transferencia, saldo_despues, creado_por)
           VALUES (?, ?, ?, 'ingreso', ?, ?, ?, ?, 1, ?, ?, ?)`,
          [ingresoId, req.organizacion.id, cuenta_destino_id, montoNum, fecha, desc, referencia || null,
           egresoId, saldoDestino + montoNum, req.usuario.id]
        );
      } else {
        throw err;
      }
    }

    // Actualizar saldos de cuentas
    await db.query(
      'UPDATE cuentas_bancarias SET saldo_actual = saldo_actual - ? WHERE id = ?',
      [montoNum, cuenta_origen_id]
    );

    await db.query(
      'UPDATE cuentas_bancarias SET saldo_actual = saldo_actual + ? WHERE id = ?',
      [montoNum, cuenta_destino_id]
    );

    console.log('✅ Transferencia creada:', { egresoId, ingresoId, monto: montoNum });

    res.status(201).json({ 
      mensaje: 'Transferencia realizada',
      egreso_id: egresoId,
      ingreso_id: ingresoId
    });
  } catch (error) {
    console.error('❌ Error en transferencia:', error);
    next(error);
  }
});

// DELETE /api/transacciones/transferencia/:id
router.delete('/transferencia/:id', auth, requireOrg, async (req, res, next) => {
  try {
    console.log('🗑️ ========== DELETE /api/transacciones/transferencia/:id ==========');

    // Obtener la transacción y su par
    const [transaccion] = await db.query(
      `SELECT t.*, c.saldo_actual 
       FROM transacciones t
       JOIN cuentas_bancarias c ON c.id = t.cuenta_bancaria_id
       WHERE t.id = ? AND t.organizacion_id = ? AND t.es_transferencia_interna = 1`,
      [req.params.id, req.organizacion.id]
    );

    if (!transaccion.length) {
      return res.status(404).json({ error: 'Transferencia no encontrada' });
    }

    const tx = transaccion[0];
    const parId = tx.id_par_transferencia;

    // Obtener transacción par
    const [parTx] = await db.query(
      `SELECT t.*, c.saldo_actual 
       FROM transacciones t
       JOIN cuentas_bancarias c ON c.id = t.cuenta_bancaria_id
       WHERE t.id = ? AND t.organizacion_id = ?`,
      [parId, req.organizacion.id]
    );

    const monto = parseFloat(tx.monto) || 0;

    // Revertir saldos según el tipo
    if (tx.tipo === 'egreso') {
      // Devolver a cuenta origen
      await db.query(
        'UPDATE cuentas_bancarias SET saldo_actual = saldo_actual + ? WHERE id = ?',
        [monto, tx.cuenta_bancaria_id]
      );
      // Quitar de cuenta destino
      if (parTx.length) {
        await db.query(
          'UPDATE cuentas_bancarias SET saldo_actual = saldo_actual - ? WHERE id = ?',
          [monto, parTx[0].cuenta_bancaria_id]
        );
      }
    } else {
      // Devolver a cuenta origen (par es el egreso)
      if (parTx.length) {
        await db.query(
          'UPDATE cuentas_bancarias SET saldo_actual = saldo_actual + ? WHERE id = ?',
          [monto, parTx[0].cuenta_bancaria_id]
        );
      }
      // Quitar de cuenta destino
      await db.query(
        'UPDATE cuentas_bancarias SET saldo_actual = saldo_actual - ? WHERE id = ?',
        [monto, tx.cuenta_bancaria_id]
      );
    }

    // Eliminar ambas transacciones
    await db.query('DELETE FROM transacciones WHERE id = ?', [req.params.id]);
    if (parId) {
      await db.query('DELETE FROM transacciones WHERE id = ?', [parId]);
    }

    console.log('✅ Transferencia eliminada:', req.params.id);

    res.json({ mensaje: 'Transferencia eliminada' });
  } catch (error) {
    console.error('❌ Error eliminando transferencia:', error);
    next(error);
  }
});

// PUT /api/transacciones/transferencia/:id/estado
// Permite actualizar el estado de una transferencia (y su par) sin eliminar/crear movimientos.
//
// Importante:
// - Este "estado_transferencia" es un metadato operativo (tracking) y NO cambia saldos.
// - Relacionado con:
//   - truno-front/transferencias/transferencias.js (select Estado en tabla)
//   - truno-back/src/db/migrate.js (asegura columna transacciones.estado_transferencia)
router.put('/transferencia/:id/estado', auth, requireOrg, async (req, res, next) => {
  try {
    const { estado_transferencia } = req.body;
    const allowed = new Set(['recibido', 'en_transito', 'en_cuenta']);

    if (!allowed.has(String(estado_transferencia || '').toLowerCase())) {
      return res.status(400).json({ error: 'Estado inválido. Usa: recibido | en_transito | en_cuenta' });
    }

    // Obtener la transferencia y su par
    const [rows] = await db.query(
      `SELECT id, id_par_transferencia
       FROM transacciones
       WHERE id = ? AND organizacion_id = ? AND es_transferencia_interna = 1`,
      [req.params.id, req.organizacion.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Transferencia no encontrada' });
    }

    const tx = rows[0];
    const parId = tx.id_par_transferencia;

    // Actualizar ambos registros (si existe el par)
    try {
      await db.query(
        `UPDATE transacciones
         SET estado_transferencia = ?
         WHERE organizacion_id = ? AND id IN (?, ?)` ,
        [estado_transferencia, req.organizacion.id, tx.id, parId || tx.id]
      );
    } catch (err) {
      if (err && err.code === 'ER_BAD_FIELD_ERROR') {
        return res.status(500).json({
          error: 'La base de datos no tiene la columna estado_transferencia. Ejecuta migración/ALTER TABLE.'
        });
      }
      throw err;
    }

    res.json({ mensaje: 'Estado de transferencia actualizado', id: tx.id, estado_transferencia });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
