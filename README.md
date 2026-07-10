# BerryPOS

Sistema POS SaaS **local-first**, multi-tenant y multi-vertical (minimarket, comida rápida, importados), con capa de IA integrada para soporte, capacitación e inteligencia de negocio.

- 📐 Arquitectura completa: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 📏 Reglas de ingeniería: [CLAUDE.md](CLAUDE.md)

## Estado

| Fase | Estado |
|---|---|
| 1. Fundación: monorepo + dominio (dinero, impuestos, venta, pagos, caja, promos, inventario) | ✅ completa |
| 2. POS minimarket (Tauri + SQLite) | 🚧 en curso — capa de datos lista, falta UI Tauri |
| 3. Nube SaaS (API multi-tenant + sync + panel) | pendiente |
| 4. IA v1 (copiloto de soporte, reportes en lenguaje natural) | pendiente |
| 5. Restaurante (KDS, comandas, recetas) | pendiente |

## Desarrollo

```bash
pnpm install
pnpm test
pnpm typecheck
```
