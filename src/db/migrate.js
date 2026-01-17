/**
 * TRUNO - Migraciones ligeras (sin framework)
 * Objetivo:
 * - Mantener compatibilidad con instalaciones existentes donde no hay sistema de migrations.
 * - Agregar columnas nuevas de forma segura si no existen.
 *
 * Relacionado con:
 * - truno-back/src/server.js (se ejecuta al iniciar el servidor)
 * - truno-back/src/routes/transacciones.routes.js (usa transacciones.estado_transferencia)
 */

const db = require('../config/database');

/**
 * Asegura la columna `estado_transferencia` en la tabla `transacciones`.
 *
 * Uso:
 * - Transferencias internas (POST /api/transacciones/transferencia) guardan un estado:
 *   - recibido | en_transito | en_cuenta
 *
 * Nota de diseño:
 * - Guardamos en DB valores normalizados (snake_case) para consistencia.
 * - El frontend muestra etiquetas amigables ("En tránsito", etc.).
 */
async function ensureEstadoTransferenciaColumn() {
  const schema = process.env.DB_NAME;
  if (!schema) {
    console.warn('⚠️ migrate: DB_NAME no definido. Se omite migración de estado_transferencia.');
    return;
  }

  // 1) Verificar que exista la tabla
  const [[{ table_count }]] = await db.query(
    `SELECT COUNT(*) AS table_count
     FROM information_schema.tables
     WHERE table_schema = ? AND table_name = 'transacciones'`,
    [schema]
  );

  if (!table_count) {
    console.warn('⚠️ migrate: tabla "transacciones" no existe. Se omite migración de estado_transferencia.');
    return;
  }

  // 2) Verificar si ya existe la columna
  const [[{ col_count }]] = await db.query(
    `SELECT COUNT(*) AS col_count
     FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'transacciones' AND column_name = 'estado_transferencia'`,
    [schema]
  );

  if (col_count) {
    return; // ya existe
  }

  console.log('🧩 migrate: agregando columna transacciones.estado_transferencia...');

  // 3) Agregar columna inicialmente NULL para no romper en tablas grandes
  await db.query(
    `ALTER TABLE transacciones
     ADD COLUMN estado_transferencia VARCHAR(20) NULL`
  );

  // 4) Backfill conservador:
  // - Las transferencias ya existentes en el sistema hoy impactan saldo al instante,
  //   por lo cual las marcamos como "en_cuenta" por defecto.
  await db.query(
    `UPDATE transacciones
     SET estado_transferencia = 'en_cuenta'
     WHERE estado_transferencia IS NULL AND es_transferencia_interna = 1`
  );

  // 5) Setear default y NOT NULL para nuevas filas
  await db.query(
    `ALTER TABLE transacciones
     MODIFY COLUMN estado_transferencia VARCHAR(20) NOT NULL DEFAULT 'en_cuenta'`
  );

  console.log('✅ migrate: columna estado_transferencia creada y backfill aplicado.');
}

module.exports = {
  ensureEstadoTransferenciaColumn
};

