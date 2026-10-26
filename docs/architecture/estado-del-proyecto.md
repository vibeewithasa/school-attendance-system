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
- Hecho en la rama `feat/school-catalog` (commit `ae13532`): esquema y migraciones 0000/0001 de `school_years` y `groups`,
  **aplicadas en `eta15_dev` el 2026-10-25** con respaldo previo y verificadas en PostgreSQL 18 real.
  Detalle en [modelo-catalogo-escolar.md](modelo-catalogo-escolar.md).
- Preparada, sin commit ni aplicar: migración 0002 (`groups.expected_entry_time`, hora de entrada por grupo).
- 0002 (`groups.expected_entry_time`, commit `1cd551a`) **aplicada en `eta15_dev`** con respaldo y verificada en PostgreSQL 18 real.
  Drizzle se ejecuta solo con `pnpm db:generate|db:check|db:migrate` (envoltorios protegidos, ver CLAUDE.md).
- Pendiente: endpoints y UI del catálogo; fusionar la rama a `main` (requiere revisión).

## Auth/RBAC (rama `feat/auth-rbac`)

- Catálogo escolar integrado en `main` (fast-forward, `2594a0e`).
- Arquitectura (esquema aplicado; servicios pendientes): [auth-rbac.md](auth-rbac.md) y [ADR 0004](../decisions/0004-auth-sesiones-servidor-argon2id.md) (sesiones de servidor propias, Argon2id nativo, separación de dominios `school`/`technical`).
- Auditoría de seguridad hecha: 14 riesgos confirmados con evidencia y corregidos (bootstrap, recuperación, autoridad delegable, sesiones, concurrencia); ver auth-rbac.md §14.
- Implementado: esquema de 8 tablas, migraciones `0003`–`0005` (**aplicadas en `eta15_dev` el 2026-10-26**, commit `df82d6d`, con respaldo previo; verificadas en el PostgreSQL 18 real, 40 comprobaciones con `ROLLBACK`; sin usuarios, sesiones, tokens ni auditoría), triggers de integridad, semilla de roles/permisos, lógica pura de autorización (rol, recurso, campo) y política de sesiones. Pruebas: unitarias/contractuales, de esquema en PGlite y de concurrencia en un clúster PG 18 desechable (`pnpm test:pg-temp`).
- **Separación de roles de PostgreSQL** (commit `cdcb449`): API como `eta15_api`, migraciones como `eta15_app`; ver [roles-postgresql.md](roles-postgresql.md).
- **Servicio de contraseñas** (Argon2id con `node:crypto`, formato PHC versionado, `needsRehash`) y **servicio de sesiones** (token opaco de 256 bits, solo SHA-256 en BD, caducidad absoluta/inactiva por rol, tope de 5, revocación individual/global, revalidación de cuenta/roles/permisos), ambos sin Fastify (los usan los endpoints de §9.3). Detalle en [auth-rbac.md §9.1–9.2](auth-rbac.md). Pruebas: 501 unitarias/PGlite/componentes (479 API + 22 React), 30 reales contra `eta15_dev`, 120 en el clúster desechable (concurrencia incluida).
- **Autenticación HTTP** (`POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `GET /auth/csrf`): cookie `HttpOnly`/`SameSite=Strict` (`__Host-` y `Secure` en producción), CSRF por Origin + Fetch Metadata + token ligado a la sesión, límites de intentos en memoria, respuesta 401 uniforme. Detalle y limitaciones en [auth-rbac.md §9.3](auth-rbac.md). Probada con `inject` (45 casos) en PGlite y en un clúster PG desechable con los privilegios de `eta15_api`; en `eta15_dev` real solo se comprobó que responde 401 sin sesión. **MFA pospuesto por decisión del proyecto** ([auth-rbac.md §11](auth-rbac.md)): por defecto (`AUTH_MFA_ENFORCEMENT=required`) `direccion` y `admin_tecnico` no pueden entrar; con `AUTH_MFA_ENFORCEMENT=deferred` en el `.env` local entran con correo y contraseña (sesión sin `mfa_verified_at`, alta auditada, aviso al arrancar). La API rechaza `deferred` con `NODE_ENV=production` o fuera de loopback. No hay migración 0006: la base real conserva `requires_mfa = true`. Esta excepción **no autoriza datos reales**: ver las condiciones de §11.3.
- **Administración de cuentas** (`/admin/users`, `/admin/roles`): crear cuentas **pendientes**, listar/consultar con paginación y filtros, deshabilitar, asignar y revocar roles existentes; actor solo desde la sesión, dominios separados, sin autoasignación, protección del último titular, auditoría y puerta de MFA ([§9.4](auth-rbac.md)). `role_permissions` sigue siendo de solo lectura.
- **Bootstrap controlado** (`pnpm auth:bootstrap`): implementado y probado en clúster desechable; dominio `technical` habilitado, **`school` BLOQUEADO** hasta que exista un procedimiento verificable para la primera autoridad escolar; **no ejecutado en `eta15_dev`** ([§5](auth-rbac.md)).
- **Activación de cuentas**: contratos Zod preparados, **sin endpoints**; las cuentas creadas por la administración quedan pendientes ([§6](auth-rbac.md)).
- **Login web** (`apps/web-admin`): pantalla institucional, sesión por cookie `HttpOnly`, rutas protegidas y cierre de sesión con CSRF; probada con jsdom (22) y en una pasada real del navegador contra `pnpm dev:sandbox` ([§9.5](auth-rbac.md)).
- **Compilación de la API**: `pnpm build` empaqueta `dist/server.js` con esbuild (`@eta15/shared-contracts` es TypeScript y ahora aporta código de ejecución; con `tsc` solo, el servidor compilado no arrancaba).
- Próximo módulo: activación/recuperación por reclamo (endpoints), pantalla de administración de cuentas y desbloqueo del bootstrap escolar tras definir su procedimiento.
- No implementado: MFA/TOTP (pospuesto), política de contraseñas (complejidad/lista común), activación/recuperación por HTTP, edición de permisos de roles, pantallas de administración, rate limiting compartido entre instancias. **No existe ningún usuario** (ni real ni de prueba) en `eta15_dev`: nadie puede iniciar sesión hasta ejecutar el bootstrap técnico con una persona titular presente.

## Limitaciones conocidas

- `/health` es liveness y `/ready` es readiness (ver base-de-datos-local.md). La API aún no usa las tablas del catálogo ni las de Auth.
- La autenticación por correo y contraseña y la administración básica de cuentas existen y están probadas, pero **no hay datos escolares protegidos todavía** (alumnos, asistencia) ni MFA; no deben usarse datos reales (ver [auth-rbac.md §11.3](auth-rbac.md)).
- **Roles separados (2026-10-26)**: la API usa `eta15_api` (mínimo privilegio) y las migraciones `eta15_app` (propietario), con archivos de entorno distintos; verificado con 30 pruebas reales y 25 en clúster desechable. Residual: `PUBLIC` conserva `CONNECT` en `beauty_pos` y `postgres`; las contraseñas locales pueden ser débiles (rotarlas antes de cualquier uso real). Ver [roles-postgresql.md](roles-postgresql.md).
- Sin CI ni Git remoto.
