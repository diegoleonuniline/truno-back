# TRUNO API - Rutas REST

## Autenticación
Todas las rutas (excepto /auth/login y /auth/register) requieren:
- Header: `Authorization: Bearer {token}`
- Header: `X-Organization-Id: {organization_uuid}`

## Auth
```
POST   /api/auth/register          - Registrar usuario
POST   /api/auth/login             - Iniciar sesión
GET    /api/auth/me                - Usuario actual + organizaciones
POST   /api/auth/change-password   - Cambiar contraseña
```

## Organizations
```
GET    /api/organizations              - Listar mis organizaciones
POST   /api/organizations              - Crear organización
GET    /api/organizations/:id          - Detalle organización
PUT    /api/organizations/:id          - Actualizar organización
GET    /api/organizations/:id/members  - Listar miembros
POST   /api/organizations/:id/invite   - Invitar miembro
DELETE /api/organizations/:id/members/:userId - Remover miembro
```

## Bank Accounts
```
GET    /api/bank-accounts              - Listar cuentas
GET    /api/bank-accounts/:id          - Detalle cuenta
POST   /api/bank-accounts              - Crear cuenta
PUT    /api/bank-accounts/:id          - Actualizar cuenta
DELETE /api/bank-accounts/:id          - Eliminar cuenta (soft)
POST   /api/bank-accounts/:id/adjust   - Ajustar saldo
```

## Transactions (Registro Simple)
```
GET    /api/transactions               - Listar transacciones
GET    /api/transactions/:id           - Detalle transacción
POST   /api/transactions               - Crear transacción
POST   /api/transactions/transfer      - Transferencia entre cuentas
PUT    /api/transactions/:id           - Actualizar transacción
DELETE /api/transactions/:id           - Eliminar transacción
POST   /api/transactions/:id/convert   - Convertir a registro avanzado
```

## Contacts
```
GET    /api/contacts                   - Listar contactos
GET    /api/contacts/:id               - Detalle contacto
POST   /api/contacts                   - Crear contacto
PUT    /api/contacts/:id               - Actualizar contacto
DELETE /api/contacts/:id               - Eliminar contacto (soft)
GET    /api/contacts/:id/transactions  - Transacciones del contacto
```

## Sales (Registro Avanzado - Ventas)
```
GET    /api/sales                      - Listar ventas
GET    /api/sales/:id                  - Detalle venta + items + pagos
POST   /api/sales                      - Crear venta
PUT    /api/sales/:id                  - Actualizar venta
DELETE /api/sales/:id                  - Eliminar venta
POST   /api/sales/:id/schedule         - Crear programación de pagos
```

## Expenses (Registro Avanzado - Gastos)
```
GET    /api/expenses                   - Listar gastos
GET    /api/expenses/:id               - Detalle gasto + items + pagos
POST   /api/expenses                   - Crear gasto
PUT    /api/expenses/:id               - Actualizar gasto
DELETE /api/expenses/:id               - Eliminar gasto
POST   /api/expenses/:id/schedule      - Crear programación de pagos
GET    /api/expenses/meta/categories   - Categorías usadas
```

## Payments
```
POST   /api/payments                   - Registrar pago
GET    /api/payments                   - Listar pagos
DELETE /api/payments/:id               - Cancelar pago
GET    /api/payments/pending           - Pagos pendientes/vencidos
```

## Categories
```
GET    /api/categories                 - Categorías usadas
GET    /api/categories/suggestions     - Sugerencias predefinidas
```

## Reports
```
GET    /api/reports/dashboard          - Dashboard principal
GET    /api/reports/cashflow           - Flujo de efectivo
GET    /api/reports/profit-loss        - Estado de resultados
GET    /api/reports/accounts-summary   - Resumen de cuentas
GET    /api/reports/aging              - Antigüedad de saldos
```

## Upload (Cloudinary)
```
POST   /api/upload                     - Subir archivo
POST   /api/upload/multiple            - Subir múltiples archivos
DELETE /api/upload/:publicId           - Eliminar archivo
```

## SAT (Validación CFDI)
```
POST   /api/sat/validate               - Validar CFDI
POST   /api/sat/validate-batch         - Validar múltiples CFDIs
GET    /api/sat/status/:uuid           - Estado de CFDI
POST   /api/sat/link                   - Vincular CFDI a venta/gasto
```

---

## Parámetros de Query Comunes

### Paginación
- `page`: Número de página (default: 1)
- `limit`: Registros por página (default: 50)

### Filtros
- `start_date`: Fecha inicio (YYYY-MM-DD)
- `end_date`: Fecha fin (YYYY-MM-DD)
- `search`: Búsqueda por texto
- `status`: Estado de pago
- `type`: Tipo (ingreso/egreso, cliente/proveedor)
- `category`: Categoría

### Dashboard
- `period`: week, month, quarter, year

---

## Códigos de Respuesta
- 200: OK
- 201: Creado
- 400: Error de validación
- 401: No autenticado
- 403: Sin permisos / Módulo no disponible
- 404: No encontrado
- 500: Error del servidor
