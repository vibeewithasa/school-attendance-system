# Arquitectura

Resumen: monolito modular (API Fastify) + clientes web/Android/PWA sobre PostgreSQL.

```
 web-admin (React) ─┐
 android-prefectura ─┼──HTTP/JSON──> apps/api (Fastify) ──Drizzle──> PostgreSQL 18 (eta15_dev)
 access-pwa ─────────┘                 └─ modules/<modulo>/{routes,service,repo,schema}
```

- Contratos tipados compartidos: `packages/shared-contracts`.
- Estado actual (Sprint 0.4): solo `GET /health` (liveness) y pantalla inicial del portal.
- Diagramas y descripciones de módulos se agregan aquí al diseñarlos.
