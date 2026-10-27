# Arquitectura

Resumen: monolito modular (API Fastify) + clientes web/Android/PWA sobre PostgreSQL.

```
 web-admin (React) ─┐
 android-prefectura ─┼──HTTP/JSON──> apps/api (Fastify) ──Drizzle──> PostgreSQL 18 (eta15_dev)
 access-pwa ─────────┘                 └─ modules/<modulo>/{routes,service,repo,schema}
```

- Contratos tipados compartidos: `packages/shared-contracts`.
- Estado actual y módulos: [estado-del-proyecto.md](estado-del-proyecto.md).
- Módulos escolares: [catálogo](modelo-catalogo-escolar.md), [alumnos y matrículas](modelo-alumnos-matriculas.md), [asignaciones de prefectura](modelo-asignaciones-prefectura.md) y [asistencia diaria](diseno-asistencia-diaria.md) (migración 0010 y privilegios 0005 aplicados en `eta15_dev`, sin datos).
- Seguridad y roles: [auth-rbac.md](auth-rbac.md), [roles-postgresql.md](roles-postgresql.md), [base-de-datos-local.md](base-de-datos-local.md).
