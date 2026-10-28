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
pnpm dev:web           # web en 127.0.0.1:5173 (usar SIEMPRE esta dirección, no localhost)
pnpm dev:sandbox       # API + PostgreSQL desechable con cuentas FICTICIAS (login, /personal, /activar, /catalogo); Ctrl+C lo destruye
pnpm dev:sandbox -- --catalog-write --students-write --prefect-write   # además aplica las propuestas de privilegios 0002 (catálogo), 0003 (alumnos) y 0004 (asignaciones de prefectura) SOLO en el clúster desechable; trae dos prefectas ficticias
pnpm dev:sandbox -- --catalog-write --students-write --prefect-write --attendance-write --seed-attendance   # + propuesta 0005 (asistencia) y un ciclo, dos grupos y alumnos FICTICIOS; opcional --school-today=AAAA-MM-DD (p. ej. un sábado)
pnpm dev:sandbox -- --catalog-write --students-write --prefect-write --attendance-write --seed-attendance --mobile-auth --mobile-attendance-read  # + LECTURA móvil de asistencia (solo GET; ADR 0006 propuesto); solo en el clúster desechable
pnpm dev:sandbox -- --catalog-write --students-write --prefect-write --attendance-write --seed-attendance --mobile-auth --mobile-attendance-read --mobile-attendance-write  # + ESCRITURA móvil de asistencia (solo abrir y guardar marcas; ADR 0006 propuesto); solo en el clúster desechable
pnpm auth:bootstrap -- ...  # bootstrap de la primera autoridad (consola, persona presente; ver auth-rbac.md §5)
pnpm auth:second-authority -- ...  # dispensa excepcional del control dual para la 2.ª autoridad (consola, con acta; ver auth-rbac.md §9.6)
pnpm db:apply-privileges <propuesta> --sha256=<hash> [--execute]  # aplica una propuesta de privilegios REVISADA (ensayo con ROLLBACK por defecto; ver tools/db/privileges)
pnpm db:mobile-cleanup # ENSAYO (ROLLBACK) de la limpieza del estado efímero móvil y retención de IP; --execute solo con autorización de operación (ver ADR 0005; las tablas aún no existen en eta15_dev)
pnpm db:state          # informe de SOLO LECTURA de eta15_dev (migraciones, tablas, extensiones, conteos, matriz RBAC y privilegios de la API; sin secretos)
pnpm typecheck; pnpm lint; pnpm test; pnpm build
```

Android (`apps/android-prefectura`, no es un paquete pnpm; ver `docs/architecture/android-prefectura.md`):

```powershell
. .\tools\env.ps1                  # JAVA_HOME (JDK 21) y ANDROID_HOME
cd apps\android-prefectura
.\gradlew.bat :app:assembleDebug :app:testDebugUnitTest :app:lintDebug     # compilar, pruebas JVM y lint
.\gradlew.bat :app:connectedDebugAndroidTest                               # requiere el emulador Medium_Phone_API_36.1 encendido
```

## 5. Seguridad

- Nunca versionar credenciales: `.env*` está ignorado; solo `.env.example` sin secretos.
- Nunca imprimir contraseñas, tokens ni cadenas de conexión en logs, chat o commits.
- La contraseña de `eta15_app` la teclea la persona usuaria (`\password`); no se pasa por argumentos ni archivos.
- Datos de alumnos: ninguno real en desarrollo, pruebas ni fixtures. Usar datos sintéticos.
- La API escucha en 127.0.0.1 por defecto. Errores 5xx no exponen detalles internos.
- El rol de la aplicación es `eta15_api` (mínimo privilegio, no propietario) y su contraseña vive en `apps/api/.env`; las migraciones y la consola usan `eta15_app` desde `apps/api/.env.migrator`. La API se niega a arrancar con un rol propietario/privilegiado, y `pnpm db:migrate` verifica que el rol sea el propietario. `pnpm db:whoami` comprueba ambas identidades. Nunca conceder `TRIGGER`, `TRUNCATE`, `REFERENCES` ni `ALL` a `eta15_api`.
- Autenticación HTTP (`/auth/login|logout|me|csrf`): cookie de sesión `HttpOnly` + `SameSite=Strict` (`__Host-` y `Secure` en producción); el token nunca va en JSON, URL ni logs; toda mutación exige `Origin` permitido y, autenticada, `X-CSRF-Token`; MFA/TOTP está pospuesto: por defecto `direccion`/`admin_tecnico` no obtienen sesión; solo con `AUTH_MFA_ENFORCEMENT=deferred` (desarrollo local con datos sintéticos; la API lo rechaza en producción o fuera de loopback) entran con contraseña, con alta auditada. Esa excepción no autoriza datos reales (`auth-rbac.md` §11.3). En desarrollo usar siempre `http://127.0.0.1:5173`. Ver `docs/architecture/auth-rbac.md` §9.3.
- `eta15_api` es de solo lectura sobre `role_permissions` (`tools/db/privileges/0001-…`): nada de la API debe escribirlo sin una revisión de seguridad propia.
- Escritura del catálogo (aplicada en `eta15_dev` el 2026-10-26): `eta15_api` tiene `INSERT`/`UPDATE` **solo por columna** en `school_years` y `groups` (`tools/db/privileges/0002-…`, verificable con `0002-school-catalog-write.verify.sql`); nunca `DELETE`, `TRUNCATE`, `TRIGGER` ni `REFERENCES`. Los privilegios se aplican con `pnpm db:apply-privileges` (preflight + `GRANT` + verificador en una transacción), no con SQL pegado a mano. El catálogo lo administra solo `direccion` (`catalog:manage_school`; política técnica pendiente de ratificación institucional).
- Alumnos y matrículas (`/school/*`; migraciones 0007 y 0008 y privilegios 0003 **aplicados** en `eta15_dev` el 2026-10-27, sin datos): datos mínimos de menores (sin CURP, tutores, fotografía, datos médicos ni fecha de nacimiento), sin borrado, sin importación masiva y **sin datos reales** hasta resolver las decisiones de `docs/architecture/modelo-alumnos-matriculas.md`. Los alumnos no son cuentas de acceso. La API autoriza por permiso y alcance en la consulta y no revela expedientes fuera de alcance (404).
- Asignaciones de grupos a prefectura (migración 0009 y privilegios 0004 **aplicados** en `eta15_dev` el 2026-10-27, sin datos): hacen real el alcance `assigned_groups`. Dirección administra (`prefect_assignments:manage`); la prefectura solo consulta lo suyo (`/school/me/groups`, `/school/groups/:id/roster`) con proyección mínima (sin código escolar ni expediente: pierde `students:read`). El acceso se evalua en cada petición (cuenta activa, rol vigente, grupo activo, ciclo, asignación no revocada); revocar es inmediato y el historial no se borra. Un grupo puede tener varias prefectas (cobertura), pero la futura asistencia será una sola lista por grupo y fecha. Ver `docs/architecture/modelo-asignaciones-prefectura.md`.
- Asistencia diaria (migración 0010 y privilegios 0005 **aplicados** en `eta15_dev` el 2026-10-27, sin datos: 11 migraciones, 17 tablas, 36 asignaciones de permisos): una lista por grupo y fecha escolar (lunes a viernes, `America/Mazatlan`, "hoy" decidido por el servidor), `/school/attendance/*`. Prefectura captura solo sus grupos y solo el día de hoy; Dirección supervisa (`attendance:read` `all`) y no captura; `trabajo_social` ya no lee asistencia (0010). Padrón congelado al abrir, control optimista por `revision`, guardados idempotentes por `requestId`, lista finalizada inmutable, historial solo-agregar (`attendance_events`), sin `DELETE`; la corrección formal (`attendance:correct`) está **bloqueada** hasta que la institución decida. No hay Android, offline, justificantes ni retardos de puerta. Ver `docs/architecture/diseno-asistencia-diaria.md`.
- App Android de prefectura (etapas 1 y 2A): Kotlin + Compose + Room, **solo datos ficticios** en modo demostración (únicamente debug; en release no existe), captura **local** sin login ni envío ni sincronización. La base local está **cifrada** (Room + SQLCipher 4.20.0, clave aleatoria envuelta con Android Keystore en `noBackupFilesDir`; falla cerrado: nunca crea una base vacía ni borra ante un error de clave), pero **cifrar no habilita datos escolares reales**: faltan autenticación móvil, revocación y decisiones institucionales (`docs/decisions/0005-android-autenticacion-movil.md`, propuesta con comparación de opciones, NO aceptada). No se versionan `local.properties`, `build/`, `.gradle/`, APK ni llaves; sin firma release. No debilitar CSRF/Origin de la API web para acomodar a la app.
- Autenticación móvil aislada (prototipo de la Opción A del ADR 0005, **propuesta no aceptada**, rama `feat/android-mobile-auth`): migraciones `0011_mobile_device_auth` y `0012_mobile_ip_retention` y privilegios `0006-mobile-auth-write` **NO aplicados** a `eta15_dev` (se prueban con PGlite y clústeres desechables; `pnpm dev:sandbox -- --catalog-write --students-write --prefect-write --attendance-write --seed-attendance --mobile-auth` solo en el clúster desechable; `SANDBOX_PASSWORD` opcional define la contraseña ficticia de ese arranque sin imprimirla). Canal `/mobile/*` sin cookies ni CSRF (rechaza `Origin`), identidad por clave de dispositivo en Keystore + DPoP con anti-replay y nonces compartidos en PostgreSQL (tablas efímeras de la 0011; falla cerrado); la vinculación en Android existe **solo en debug** (release sin `INTERNET` ni cliente de red). No se tocó CSRF/Origin globales ni MFA; las cuentas con rol que exige MFA no son elegibles. Sin datos reales, sin sincronización ni envío de asistencia.
- Caché offline Android (prototipo SANDBOX, rama `feat/android-offline-cache`, **apilada sobre** `feat/android-mobile-auth`/PR #2; no aprobada): la app **debug** descarga de `/mobile/school/*` solo los grupos y alumnos autorizados a la cuenta vinculada (todo o nada, proyección mínima) a la base Room/SQLCipher v2 y permite capturar sin internet; **no envía asistencia ni sincroniza**, no hay `POST` de asistencia, reintentos ni WorkManager, y release sigue sin `INTERNET`. Vigencia offline corta solo SANDBOX (`-Peta15.offlineValidityMinutes`), bloqueo por reloj sospechoso, revocaciones detectadas **al reconectar** (offline no se puede saber), borradores nunca se borran en silencio, aislamiento por `sbx.<deviceId>`. No usar `REPLACE` en los DAO (borraría en cascada borradores y marcas) ni `fallbackToDestructiveMigration`. Sin datos reales. Ver `docs/architecture/android-prefectura.md`.
- Lectura móvil de asistencia (prototipo SANDBOX, rama `feat/mobile-attendance-read`, apilada sobre PR #4/#3/#2; ADR 0006 **propuesto**, no aceptado): solo `GET /mobile/school/attendance/{today,days,days/:id}`, detrás de la opción explícita `mobile.attendanceRead` (apagada por omisión; sandbox con `--mobile-attendance-read`; el canal móvil no se monta con `NODE_ENV=production`). Mismo servicio que el portal, foto consistente (REPEATABLE READ) y proyección mínima sin nombres. El token móvil lleva `attendance:read` solo con `assigned_groups` y **nunca** `attendance:capture`: **no hay escritura de asistencia por el canal móvil** ni sincronización. Sin migraciones ni `GRANT` nuevos. Ver `docs/architecture/protocolo-sincronizacion-asistencia.md` §18.
- Escritura móvil de asistencia (fase 2, prototipo SANDBOX, rama `feat/mobile-attendance-write-sandbox`, apilada sobre PR #5; ADR 0006 **propuesto**): solo `POST /mobile/school/attendance/days` (abrir hoy) y `POST …/days/:id/marks` (guardar), detrás de `mobile.attendanceWrite` (apagada por omisión; exige `attendanceRead`; sandbox con `--mobile-attendance-write`; la aplicación no se construye con `NODE_ENV=production`). El token móvil lleva `attendance:capture` (solo `assigned_groups`) únicamente con ese interruptor. **No existen finalizar, borrar ni capturas históricas por el canal móvil**; Android **no** envía nada todavía (sin outbox ni WorkManager). La idempotencia es por `requestId` + huella, durable en `attendance_events` (un guardado sin cambios deja un evento `mark_changed` de confirmación con `old = new`; `GET …/events` lo excluye y quien consulte la tabla directamente debe excluir esas filas). Las lecturas de asistencia (portal y móvil) usan una foto REPEATABLE READ por omisión. Sin migraciones ni `GRANT`. Ver `docs/architecture/protocolo-sincronizacion-asistencia.md` §19.
- Outbox local Android (prototipo SANDBOX, rama `feat/android-offline-outbox`, apilada sobre PR #6/#5/#4/#3/#2; ADR 0005/0006 **propuestos**): Room **v3** (`MIGRATION_2_3` aditiva, `3.json` versionado, nunca `fallbackToDestructiveMigration`, SQLCipher/Keystore intactos) con `sync_operations` y `sync_operation_marks` solo para perfiles SANDBOX (la demostración no tiene outbox). «Preparar para sincronizar» **solo sella datos locales**: `requestId` UUID, payload mínimo (sin Pendientes) y hash idéntico al del backend; `dayId`/`expectedRevision` quedan fuera de la identidad sellada y nulos hasta un transporte futuro (`WAITING_REMOTE_CONTEXT`, nunca inventados). Operaciones selladas inmutables (también por disparadores SQL), estados `LOCAL_ONLY…DISCARDED` con transiciones validadas, `SENDING` tras reinicio = resultado desconocido. Fecha histórica, padrón cambiado, alumno inactivo y grupo/dispositivo revocado pasan a `NEEDS_REVIEW` sin tocar marcas. **Android no envía asistencia**: sin cliente HTTP de escritura, `WorkManager`, reintentos ni finalización; los métodos de «transporte futuro» de `OutboxStore` solo los llaman las pruebas (prueba estática). Release sin `INTERNET`. No usar `REPLACE` ni textos «Enviado/Sincronizado». Ver `docs/architecture/android-prefectura.md` y `protocolo-sincronizacion-asistencia.md` §21.

- Transporte manual de asistencia Android (prototipo SANDBOX, rama `feat/android-manual-sync-sandbox`, apilada sobre PR #7/#6/#5/#4/#3/#2; ADR 0005/0006 **propuestos**): **solo en `src/debug`** (motor `ManualSyncEngine`, cliente HTTP con DPoP `HttpMobileApi`+`AttendanceApi`, `SyncPolicy`, `DeviceSyncSessions`, `RoomSyncStore`); en `main` solo el puerto `ManualSync`/`NoManualSync` y la interfaz; el release no contiene el transporte ni `INTERNET`. Un ciclo lo inicia **únicamente** «Sincronizar ahora» (nunca al abrir, reconectar, reiniciar, iniciar sesión, navegar, preparar ni por temporizador; sin WorkManager; un solo ciclo a la vez; cancelable). Solo las cuatro rutas `GET today`, `GET days/:id`, `POST days` (abrir) y `POST days/:id/marks` (guardar): **sin finalizar, borrar ni capturas históricas**. La autoridad sobre «hoy», lista, padrón y revisión es el servidor; `requestId`, payload y huella sellados no cambian en ningún reintento (`jti` DPoP nuevo por petición); `SENDING` se persiste antes de enviar y el éxito se informa solo tras guardar el recibo (una sentencia atómica). `NEEDS_REVIEW` y `CONFLICT` bloquean y **no se limpian solos** (política conservadora; falta la decisión de la escuela). Los disparadores de la outbox se reinstalan solo si cambiaron (abrir no escribe). Auditoría 45: el CÓDIGO de error manda sobre el estado (el backend responde 401 `DEVICE_REVOKED`); lo bloqueado de otra fecha no impide sincronizar hoy; `SecureStorage.open()` está serializado en todo el proceso. Ver `docs/architecture/android-prefectura.md` y `protocolo-sincronizacion-asistencia.md` §22.

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
