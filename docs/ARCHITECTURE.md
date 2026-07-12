# BerryPOS — Blueprint de arquitectura

> Sistema POS SaaS de grado producción: local-first, multi-tenant, multi-vertical, con IA integrada.

## 1. Principios

1. **La venta nunca depende de la red.** La caja opera contra SQLite local; la nube es sincronización, respaldo y análisis.
2. **Ledgers, no saldos.** Inventario y caja se registran como movimientos append-only; los saldos son proyecciones. Esto hace el sync offline determinista y da auditoría gratis.
3. **Idempotencia total.** Cada evento (venta, movimiento, cierre) nace con UUID en el cliente; reintentos de sync jamás duplican.
4. **Un dominio, muchas cáscaras.** `packages/domain` contiene toda la lógica de negocio pura; POS, API y panel solo la invocan.
5. **Multi-tenant real.** `tenant_id` + Row-Level Security en PostgreSQL desde la migración 0001.

## 2. Topología

```
┌─────────── TIENDA (100% offline-capable) ─────────────┐
│  apps/pos — Tauri 2 + React + Vite                     │
│  ├─ SQLite (WAL) vía Drizzle — fuente de verdad local  │
│  ├─ Hardware: térmica ESC/POS, gaveta, balanza, escáner│
│  ├─ KDS (pantalla de cocina) en la LAN                 │
│  └─ Outbox de eventos → sync cuando hay red            │
└──────────────────────┬─────────────────────────────────┘
                       │ HTTPS + WebSocket (push de catálogo)
┌──────────────────────▼─────────────────────────────────┐
│  NUBE SaaS                                              │
│  apps/api — NestJS + Fastify                            │
│  ├─ PostgreSQL 16 multi-tenant (tenant_id + RLS)        │
│  ├─ Módulo sync (inbox idempotente, reconciliación)     │
│  ├─ Módulo ai  — gateway a Claude API (ver §5)          │
│  ├─ Facturación electrónica: adaptador por país         │
│  └─ Billing de suscripciones y licencias por caja       │
│  apps/admin — React SPA: reportes, catálogo, multi-sucursal│
└─────────────────────────────────────────────────────────┘
```

## 3. Sincronización offline

- **Outbox (tienda → nube):** ventas, movimientos de inventario, sesiones de caja. Append-only, orden causal por secuencia local, reintentos con backoff. La nube aplica en un inbox idempotente (dedup por UUID).
- **Downstream (nube → tienda):** catálogo, precios, promociones, usuarios. Versionado por `revision`; la tienda aplica el snapshot/diff más reciente.
- **Conflictos:** no existen para eventos (append-only). Para datos maestros gana la nube (last-write-wins por revisión). El stock nunca se sincroniza como valor absoluto: se reconcilia sumando movimientos.

## 4. Dominio y verticales

**Núcleo:** venta multi-pago (efectivo/tarjeta/transferencia/mixto/fiado), caja (apertura, arqueo ciego, retiros, cierre Z), catálogo con variantes y códigos de barras, inventario por ledger, compras/recepción, clientes y crédito, promociones (2x1, % por categoría, precio por volumen), roles con PIN de cajero, reportes.

| Vertical | Módulos específicos |
|---|---|
| Minimarket | Pesables con balanza y EAN-13 de peso (prefijos 20–29), unidades duales (caja/unidad), lotes y vencimientos, listas de precios (mayorista/minorista), sugerido de compra |
| Comida rápida | Modificadores y combos, comanda a cocina, KDS con estados, tipos de orden (local/llevar/delivery), recetas/escandallo que descuentan insumos |
| Importados | Multi-moneda, costeo de importación prorrateado (flete/aduana), series/IMEI, garantías |

## 5. Capa de IA (módulo `ai` en la API)

Gateway único a la Claude API; ninguna app llama al proveedor directamente. Reglas: contexto SIEMPRE acotado al tenant (tool-use sobre repositorios con RLS), sin datos cruzados, logging de prompts/costos por tenant, degradación elegante (si la IA cae, el POS ni se entera).

| Capacidad | Descripción |
|---|---|
| Copiloto de soporte | Asistente in-app (POS y panel) que responde "¿cómo hago X?" con RAG sobre la documentación del producto y la configuración del tenant |
| Capacitación | Onboarding interactivo por rol (cajero/administrador) + modo entrenamiento con ventas simuladas que no tocan el ledger real |
| Reportes en lenguaje natural | "¿Qué pasó hoy?" → resumen diario: ventas vs. histórico, alertas de margen, quiebres de stock |
| Sugerido de compra inteligente | Pronóstico de demanda por producto/estacionalidad → orden de compra propuesta |
| Detección de anomalías | Patrones de merma, descuadres de caja recurrentes, descuentos atípicos por cajero |
| Alta de productos asistida | Foto/descripción → nombre normalizado, categoría, atributos sugeridos |

## 6. Stack

| Capa | Tecnología |
|---|---|
| POS | Tauri 2, React 19, Vite, SQLite (WAL) + Drizzle |
| API | NestJS + Fastify, PostgreSQL 16 + Drizzle, Redis (colas/cache) |
| Panel | React 19 + Vite (SPA estática contra la API; mismo stack que el POS) |
| Compartido | TypeScript estricto, Zod en fronteras, Vitest, Playwright |
| IA | Claude API (módulo gateway `ai`) |
| Infra | Docker Compose (dev), CI: typecheck + tests en cada PR |

## 7. Fases de construcción

1. **Fundación** *(actual)*: monorepo, `packages/domain` (dinero, impuestos, venta) con tests exhaustivos.
2. **POS minimarket**: app Tauri, esquema SQLite, venta + caja + catálogo + impresión térmica.
3. **Nube**: API multi-tenant, sync, panel admin, licenciamiento.
4. **IA v1**: copiloto de soporte + reportes en lenguaje natural.
5. **Restaurante**: modificadores, combos, comanda, KDS, recetas.
6. **Facturación electrónica** (adaptador del país objetivo) + multi-sucursal.
7. **IA v2**: pronóstico de demanda, anomalías, capacitación interactiva. Vertical importados.
