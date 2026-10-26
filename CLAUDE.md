# ETA 15 — Guía para asistentes de IA y desarrolladores

Plataforma escolar de la Escuela Secundaria Técnica No. 15. Proyecto nuevo e independiente.

## 1. Arquitectura

Monolito modular. Una sola API (`apps/api`) organizada por módulos de negocio en `src/modules/<modulo>/`
(rutas, servicio, acceso a datos, esquema). Los módulos no importan internals de otros módulos; se
comunican por funciones públicas del servicio. Clientes: portal web (`web-admin`), Android (prefectura)
y PWA de acceso (futuros). Los contratos compartidos viven en `packages/shared-contracts`.

## 2. Organización del monorepo

`apps/api`, `apps/web-admin`, `apps/android-prefectura`, `apps/access-pwa`, `packages/shared-contracts`,
`packages/ui`, `docs/` (architecture, decisions), `tools/` (env.ps1, tools/db). Workspaces pnpm; sin Turborepo/Nx
hasta que una necesidad medida lo justifique (registrar en un ADR).

## 3. Stack

Node.js 24 LTS · pnpm 12.15.0 · TypeScript 6.0 (typescript-eslint aún no soporta TS 7) · Fastify 5 · Zod ·
PostgreSQL 18 · Drizzle ORM/Kit · React 19 · Vite · Tailwind CSS 4 · Vitest · Kotlin + Jetpack Compose + Room (Android).
Todo en Windows nativo: **no WSL, no Docker, no contenedores**.

## 4. Comandos locales (PowerShell)

```powershell
. .\tools\env.ps1      # primero, en cada sesión nueva
pnpm install
pnpm dev:api           # API en 127.0.0.1:3000
pnpm dev:web           # web en 127.0.0.1:5173
pnpm typecheck; pnpm lint; pnpm test; pnpm build
```

## 5. Seguridad

- Nunca versionar credenciales: `.env*` está ignorado; solo `.env.example` sin secretos.
- Nunca imprimir contraseñas, tokens ni cadenas de conexión en logs, chat o commits.
- La contraseña de `eta15_app` la teclea la persona usuaria (`\password`); no se pasa por argumentos ni archivos.
- Datos de alumnos: ninguno real en desarrollo, pruebas ni fixtures. Usar datos sintéticos.
- La API escucha en 127.0.0.1 por defecto. Errores 5xx no exponen detalles internos.
- El rol de la aplicación es `eta15_api` (mínimo privilegio, no propietario) y su contraseña vive en `apps/api/.env`; las migraciones y la consola usan `eta15_app` desde `apps/api/.env.migrator`. La API se niega a arrancar con un rol propietario/privilegiado, y `pnpm db:migrate` verifica que el rol sea el propietario. `pnpm db:whoami` comprueba ambas identidades. Nunca conceder `TRIGGER`, `TRUNCATE`, `REFERENCES` ni `ALL` a `eta15_api`.
- Riesgo aceptado en desarrollo: `eta15_app` hereda `CONNECT`/`TEMPORARY` de `PUBLIC` sobre otras bases del servidor
  (ADR 0003). En producción el rol de ejecución de la API y el rol propietario de esquema/migraciones serán distintos.
- Estado real del proyecto y módulos pendientes: `docs/architecture/estado-del-proyecto.md`. Decisiones: `docs/decisions/`.

## 6. Convenciones

- TypeScript estricto; ESM; imports de tipo con `import type`.
- Archivos en `kebab-case`; componentes React en `PascalCase`; textos de interfaz en español (es-MX).
- Prettier es la autoridad de formato; ESLint debe quedar sin errores.
- Archivos de texto UTF-8 **sin BOM**, finales de línea según `.gitattributes`.
- `/health` solo indica que el proceso HTTP responde (sin tocar la BD); `/ready` ejecuta `SELECT 1` real. No mezclarlos.
  Las respuestas y logs de `/ready` nunca incluyen mensajes de error de la BD (solo códigos). Ver `docs/architecture/base-de-datos-local.md`.
- Pruebas de integración: `pnpm test:integration` (requiere `DB_PASSWORD` en `apps/api/.env`; falla si falta, nunca se omite).

## 7. Estrategia Git

Rama `main` protegida por convención; trabajo en ramas `feat/…`, `fix/…`, `chore/…` y fusión por PR.
Commits pequeños en imperativo (Conventional Commits recomendado). No hacer push, commit ni PR sin que
la persona responsable lo pida.

## 8. Política de migraciones

- Esquema en `apps/api/src/db/schema/`; migraciones generadas con `pnpm --filter @eta15/api db:generate`
  y versionadas en `apps/api/drizzle/`.
- Revisar el SQL generado antes de aplicarlo. Aplicar (`db:migrate`) solo con autorización explícita.
- **Drizzle solo se ejecuta con los envoltorios protegidos** (`pnpm db:generate`, `pnpm db:check`, `pnpm db:migrate`; en `apps/api/scripts/`), nunca `drizzle-kit` directo. Fuerzan el directorio `apps/api` y, antes de actuar, comprueban: config y journal presentes y ordenados, esquema no vacío y sin menos tablas que el último snapshot, migraciones confirmadas en Git sin alterar, y SQL sin operaciones destructivas (`DROP`, `TRUNCATE`, `DELETE`, cambio de tipo, `RENAME`). Si el SQL generado es destructivo se descarta lo generado. `db:migrate` además exige `apps/api/drizzle` confirmado (sin cambios pendientes). No existen `--force` ni `--ignore-conflicts`; una migración destructiva intencional se escribe a mano (`--custom`) con la marca `-- eta15:allow-destructive` y aprobación explícita.
- Antes de aplicar una migración a `eta15_dev`: preflight de solo lectura, respaldo `pg_dump -Fc` fuera del repo y verificado, y pruebas de comportamiento con datos ficticios dentro de `BEGIN … ROLLBACK`.
- Lo que Drizzle no expresa (EXCLUDE, triggers) va en una migración manual (`drizzle-kit generate --custom`) y se prueba
  en `apps/api/test/*.migration.test.ts` con PGlite (en memoria; nunca contra `eta15_dev`).
- Prohibido editar migraciones ya aplicadas; se corrige con una migración nueva.
- Migraciones destructivas (DROP, TRUNCATE, cambios de tipo con pérdida) requieren aprobación y respaldo.

## 9. Pruebas

- Cada módulo nuevo trae pruebas Vitest; `buildApp()` + `app.inject()` para HTTP sin abrir puertos.
- Pruebas de integración con base de datos usan una base propia de pruebas, nunca `eta15_dev` con datos útiles.
- Pruebas de concurrencia real (varias conexiones) usan un clúster PostgreSQL **desechable** en carpeta temporal y puerto propio (`pnpm test:pg-temp`), nunca el servicio ni `eta15_dev`.
- Seguridad (Auth/RBAC): todo cambio a privilegios necesita pruebas adversariales (autoasignación, cruce de dominios, rol de API no propietario). Los permisos de autoridad (`is_authority`) solo cambian por migración. No se afirma que un endpoint es seguro mientras no exista y esté probado por HTTP; ver `docs/architecture/auth-rbac.md`.
- Un cambio no está terminado sin `typecheck`, `lint` y `test` en verde. No declarar como ejecutadas pruebas que no se corrieron.

## 10. Prohibido sin autorización explícita

Borrar o sobrescribir datos, bases, roles o archivos ajenos al cambio; `DROP`/`TRUNCATE`; `git reset --hard`,
`push --force`, reescritura de historia; modificar configuración global del equipo o de PostgreSQL
(`postgresql.conf`, `pg_hba.conf`, firewall); tocar otras bases del servidor (p. ej. `beauty_pos`) o proyectos
en `C:\Projects`; instalar o actualizar herramientas globales.
