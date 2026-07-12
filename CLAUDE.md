# BerryPOS

Sistema POS SaaS local-first, multi-tenant y multi-vertical (minimarket, comida rápida, importados), con capa de IA integrada (soporte, capacitación, inteligencia de negocio).

## Arquitectura

- **Monorepo** pnpm workspaces + Turborepo. Un solo lenguaje: TypeScript estricto en todo.
- **Local-first:** la caja (app Tauri) opera contra SQLite local y NUNCA depende de la red para vender. Sincronización por outbox/inbox de eventos.
- **Nube SaaS:** API NestJS + PostgreSQL multi-tenant (`tenant_id` + RLS), panel admin Next.js.
- **Monolito modular**, no microservicios. Los módulos de NestJS tienen fronteras limpias; se extrae un servicio solo cuando el dolor sea real y medible.
- Blueprint completo en [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Estructura

```
packages/domain    Lógica de negocio PURA (dinero, impuestos, ventas, promos, ledger).
                   Sin I/O, sin dependencias de framework. 100% testeada.
packages/*         Código compartido (contratos de sync, esquemas, config).
apps/pos           POS de caja: Tauri 2 + React + Vite + SQLite (Drizzle).
apps/api           API nube: NestJS + Fastify + PostgreSQL (Drizzle).
apps/admin         Panel web: React 19 + Vite (SPA contra la API).
```

## Reglas de ingeniería (NO negociables)

1. **Dinero siempre en enteros** (centavos, tipo `Cents`). Jamás `float` para dinero. Cantidades pesables en milésimas enteras (`QtyMilli`: 1.525 kg = 1525). El redondeo vive en UN solo lugar: `packages/domain/src/money.ts` (half-away-from-zero).
2. **Inventario y caja son ledgers append-only.** Nunca se sobreescribe un saldo; se registran movimientos. Los saldos son proyecciones.
3. **Toda escritura de venta/movimiento es idempotente:** UUID generado en el cliente. Requisito absoluto del sync offline.
4. **Lógica de negocio solo en `packages/domain`.** UI y API son cáscaras delgadas. Si un cálculo de totales/impuestos/promos aparece en una app, está en el lugar equivocado.
5. **Multi-tenant desde la primera migración:** toda tabla de nube lleva `tenant_id` con Row-Level Security. La capa de IA jamás cruza datos entre tenants.
6. **Validación con Zod en las fronteras** (entrada de API, payloads de sync, formularios). El esquema vive junto al tipo en el paquete compartido.
7. Migraciones versionadas con Drizzle Kit. Nunca editar una migración ya aplicada.
8. Todo cambio en `packages/domain` requiere tests. Los tests de dinero/impuestos verifican que las sumas cuadran al centavo (reconciliación de residuos con método del mayor resto).

## Convenciones

- Código, identificadores y comentarios en **inglés**. Docs, UI y textos de cara al usuario en **español**.
- Conventional Commits (`feat:`, `fix:`, `refactor:`, ...).
- Tests con Vitest (unitarios) y Playwright (E2E). Un bug corregido = un test que lo cubre.

## Comandos

```bash
pnpm install          # instalar dependencias del workspace
pnpm test             # tests de todo el monorepo (turbo)
pnpm typecheck        # typecheck de todo el monorepo
pnpm --filter @berrypos/domain test   # tests de un paquete
```
