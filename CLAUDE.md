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
- El rol de la aplicación no es superusuario ni crea roles/bases.
- Riesgo aceptado en desarrollo: `eta15_app` hereda `CONNECT`/`TEMPORARY` de `PUBLIC` sobre otras bases del servidor
  (ADR 0003). En producción el rol de ejecución de la API y el rol propietario de esquema/migraciones serán distintos.
- Estado real del proyecto y módulos pendientes: `docs/architecture/estado-del-proyecto.md`. Decisiones: `docs/decisions/`.

## 6. Convenciones

- TypeScript estricto; ESM; imports de tipo con `import type`.
- Archivos en `kebab-case`; componentes React en `PascalCase`; textos de interfaz en español (es-MX).
- Prettier es la autoridad de formato; ESLint debe quedar sin errores.
- Archivos de texto UTF-8 **sin BOM**, finales de línea según `.gitattributes`.
- `/health` solo indica que el proceso HTTP responde. Un readiness con base de datos será un endpoint distinto.

## 7. Estrategia Git

Rama `main` protegida por convención; trabajo en ramas `feat/…`, `fix/…`, `chore/…` y fusión por PR.
Commits pequeños en imperativo (Conventional Commits recomendado). No hacer push, commit ni PR sin que
la persona responsable lo pida.

## 8. Política de migraciones

- Esquema en `apps/api/src/db/schema/`; migraciones generadas con `pnpm --filter @eta15/api db:generate`
  y versionadas en `apps/api/drizzle/`.
- Revisar el SQL generado antes de aplicarlo. Aplicar (`db:migrate`) solo con autorización explícita.
- Prohibido editar migraciones ya aplicadas; se corrige con una migración nueva.
- Migraciones destructivas (DROP, TRUNCATE, cambios de tipo con pérdida) requieren aprobación y respaldo.

## 9. Pruebas

- Cada módulo nuevo trae pruebas Vitest; `buildApp()` + `app.inject()` para HTTP sin abrir puertos.
- Pruebas de integración con base de datos usan una base propia de pruebas, nunca `eta15_dev` con datos útiles.
- Un cambio no está terminado sin `typecheck`, `lint` y `test` en verde. No declarar como ejecutadas pruebas que no se corrieron.

## 10. Prohibido sin autorización explícita

Borrar o sobrescribir datos, bases, roles o archivos ajenos al cambio; `DROP`/`TRUNCATE`; `git reset --hard`,
`push --force`, reescritura de historia; modificar configuración global del equipo o de PostgreSQL
(`postgresql.conf`, `pg_hba.conf`, firewall); tocar otras bases del servidor (p. ej. `beauty_pos`) o proyectos
en `C:\Projects`; instalar o actualizar herramientas globales.
