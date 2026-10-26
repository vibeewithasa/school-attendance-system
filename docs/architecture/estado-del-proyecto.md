# Estado del proyecto — cierre de Sprint 0

Última actualización: 2026-10-26.

| Componente                  | Estado             | Detalle                                                                               |
| --------------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| `apps/api`                  | Inicializado       | Fastify 5, config con Zod, errores centralizados, logs JSON, `GET /health`, 4 pruebas |
| Drizzle / base de datos     | Preparado          | `drizzle.config.ts`, `src/db/client.ts` y esquema vacío. Sin tablas, sin migraciones  |
| `apps/web-admin`            | Inicializado       | React 19 + Vite + Tailwind 4, routing, `ErrorBoundary`, pantalla inicial. Sin pruebas |
| `packages/shared-contracts` | Inicializado       | Tipos `HealthResponse` y `ApiErrorBody`                                               |
| `packages/ui`               | Reservado          | Vacío                                                                                 |
| `apps/android-prefectura`   | Sin implementación | Solo carpeta (`.gitkeep`)                                                             |
| `apps/access-pwa`           | Sin implementación | Solo carpeta (`.gitkeep`)                                                             |
| Módulos escolares           | No iniciados       | Alumnos, asistencias, autenticación: fuera del alcance de Sprint 0                    |
| PostgreSQL local            | Operativo          | Base `eta15_dev`, rol `eta15_app` (sin privilegios administrativos). Ver ADR 0003     |
| Emblema institucional       | Pendiente          | No está en el repositorio; `Emblem.tsx` es un marcador                                |

## Sprint 1 (en curso)

- Hecho: pool de PostgreSQL con timeouts, `GET /ready` (200/503), cierre ordenado del pool, pruebas unitarias e integración.
  Detalle en [base-de-datos-local.md](base-de-datos-local.md).
- Hecho en la rama `feat/school-catalog` (sin commit): esquema y migración de `school_years` y `groups`, probados en memoria.
  Detalle en [modelo-catalogo-escolar.md](modelo-catalogo-escolar.md). **La migración no se ha aplicado en PostgreSQL.**
- Pendiente: autorizar y aplicar la migración; endpoints y UI del catálogo.

## Limitaciones conocidas

- `/health` es liveness y `/ready` es readiness (ver base-de-datos-local.md). La API aún no tiene tablas ni migraciones.
- Sin autenticación ni autorización.
- Sin CI ni Git remoto.
