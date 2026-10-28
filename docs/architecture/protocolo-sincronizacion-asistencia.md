# Protocolo de sincronización de asistencia (DISEÑO; fases 1 y 2 implementadas solo en el sandbox)

Estado (2026-10-28): **documento de diseño** con **dos partes implementadas en el backend de sandbox, ambas apagadas por omisión: las lecturas móviles de asistencia (§18) y la escritura móvil limitada a abrir la lista de hoy y guardar marcas (§19)**. No hay envío de asistencia desde Android, ni cola local, ni trabajos programados, ni finalización móvil, ni cambios de Room ni de `eta15_dev`. Todo lo que dice «se propone» **no está aprobado**: ni por la institución ni por una revisión de seguridad. El [ADR 0005](../decisions/0005-android-autenticacion-movil.md) y el [ADR 0006](../decisions/0006-protocolo-sincronizacion-asistencia.md) siguen **PROPUESTOS**. Todo se diseñó y se razona con datos ficticios.

Dependencia de ramas: el diseño vive en `design/attendance-sync-protocol` (PR #4, Draft), creada desde `feat/android-offline-cache` (PR #3, Draft), que depende de `feat/android-mobile-auth` (PR #2, Draft). La fase 1 vive en `feat/mobile-attendance-read` (PR #5, Draft), apilada sobre el PR #4, y la fase 2 en `feat/mobile-attendance-write-sandbox`, apilada sobre el PR #5. Ninguno está fusionado en `main`. Lo que aquí se describe como «existe» está verificado en el código de esas ramas, no en documentos antiguos.

## 1. Contexto y alcance

**Problema.** La app de prefectura ya captura Presente/Ausente/Pendiente sin internet en una base cifrada (borradores locales). Falta decidir **cómo y cuándo** esas marcas pasan a ser asistencia oficial del servidor sin duplicar eventos, sin sobrescribir en silencio, sin aceptar lo que no corresponde y sin perder borradores.

**Dentro de alcance**: operaciones, identidades, contratos HTTP de ejemplo, cola local (outbox) propuesta, concurrencia, autorización, fecha escolar, padrón histórico, matriz de conflictos, reintentos, pruebas futuras, decisiones abiertas y plan por fases.

**Fuera de alcance (no se hace en esta rama)**: código de envío, rutas nuevas, migraciones SQL, `GRANT`, workers, MFA, cambios de políticas escolares, datos reales.

**Principios** (heredados de `diseno-asistencia-diaria.md` y del ADR 0005): el servidor es la autoridad; la fecha escolar la decide el servidor; el reloj del teléfono no es autoridad; una lista finalizada es historia inmutable; sin _last-write-wins_; sin borrado; nada se declara «enviado» sin confirmación del servidor; datos mínimos de menores.

## 2. Estado real del sistema (verificado en el código)

### 2.1 Backend de asistencia (existe, canal web)

Rutas en `apps/api/src/modules/attendance/attendance.routes.ts`, prefijo `/school/attendance`, protegidas por `adminGuard` (**cookie de sesión web + puerta de MFA**) y, en mutaciones, por CSRF y `Origin`:

| Ruta                                 | Qué hace                                                                                           | Cuerpo (Zod estricto, `packages/shared-contracts/src/attendance.ts`)  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `GET /attendance/today`              | Grupos del día de quien consulta, `schoolToday`, `isSchoolDay`, resumen de la lista si existe      | sin query                                                             |
| `POST /attendance/days`              | **Obtener o crear** la lista de HOY del grupo (201 si la creó, 200 si ya existía)                  | `{ groupId, attendanceDate? }` (la fecha solo se **contrasta**)       |
| `GET /attendance/days`               | Lista paginada (`groupId`, `from`, `to`, `status`)                                                 | query                                                                 |
| `GET /attendance/days/:id`           | Detalle: `revision`, `status`, `counts`, `records[]` (alumno, estado), `editable`, `discrepancies` | —                                                                     |
| `POST /attendance/days/:id/marks`    | Guardar marcas del borrador (≤ 200 por petición, 32 KiB)                                           | `{ expectedRevision, requestId (uuid), marks:[{studentId, status}] }` |
| `POST /attendance/days/:id/finalize` | Finalizar (atómico)                                                                                | `{ expectedRevision }` — **no lleva `requestId`**                     |
| `GET /attendance/days/:id/events`    | Historial (IDs y estados; el actor solo lo ve quien supervisa)                                     | paginación                                                            |

Errores: `{ "error": { "code", "message", "requestId" } }` donde `requestId` es el **id de la petición HTTP del servidor** (no es una clave de idempotencia). El `code` es el _reason_ estable (p. ej. `REVISION_CONFLICT`) o, si no hay, `FORBIDDEN|NOT_FOUND|CONFLICT|VALIDATION|UNAVAILABLE` con HTTP 403/404/409/400/503.

Reglas relevantes verificadas en `attendance.service.ts` (`open` ~l.439, `saveMarks` ~l.652, `finalize` ~l.806):

- **Fecha**: `todayOf()` sale de la base (`America/Mazatlan`). Ninguna fecha del cliente se acepta; `attendanceDate` distinta de «hoy» → `400 DATE_NOT_TODAY`. Guardar o finalizar una lista de otro día → `409 DAY_NOT_CURRENT`. Un borrador de ayer **no tiene hoy ninguna vía ordinaria para cerrarse** (decisión institucional pendiente, `diseno-asistencia-diaria.md` §3.2).
- **Autorización por operación**: `resolveAccess` (permiso `attendance:capture`, alcance `assigned_groups`) y `lockGroupAccess` (vuelve a comprobar y **bloquea `FOR SHARE`** asignación y cuenta). Fuera de alcance == inexistente → **404 indistinguible**.
- **Idempotencia** (`saveMarks`): bajo `SELECT … FOR UPDATE` de la lista se busca un evento `mark_changed` con `(attendance_day_id, request_id)`. Si existe: mismo `payload_hash` → `200` con `replayed:true, changed:0` (**aunque la revisión haya avanzado, la fecha haya cambiado o la lista ya esté finalizada**, porque esta comprobación va antes que las de estado); distinto hash → `409 IDEMPOTENCY_MISMATCH`.
- **Huella del contenido** (`marksHash`): SHA-256 de `studentId:status` ordenado por `studentId` y unido con `|`. **Solo cubre las marcas**: no incluye `dayId`, `groupId` ni `expectedRevision`.
- **Concurrencia**: `expectedRevision != revision` → `409 REVISION_CONFLICT` (se audita `attendance.save_conflict`); sin escribir nada. Éxito con cambios: `revision + 1`, un evento `mark_changed` por renglón cambiado.
- **Padrón**: congelado al abrir (trigger `att_records_guard_insert`); `studentId` fuera del padrón congelado → `400 STUDENT_NOT_IN_LIST` y **no se aplica nada** de esa petición.
- **Estados**: solo `present` y `absent`. Un renglón marcado **nunca vuelve a pendiente** (trigger `att_records_no_unmark`).
- **Finalizar**: exige `expectedRevision`, sin pendientes (`PENDING_RECORDS`) y al menos un renglón. Si ya está finalizada devuelve `200 alreadyFinalized:true` (**sin distinguir quién la finalizó**: la prefectura no ve `finalizedBy`).
- **Historial**: `attendance_events` solo-agregar (triggers sin `UPDATE`/`DELETE`/`TRUNCATE`), índices únicos `att_events_request_record_idx (day, request_id, record)` y `att_events_once_idx`.

Restricciones de la base (migración 0010, `eta15_dev` ya la tiene): UNIQUE `(group_id, attendance_date)`, UNIQUE `(attendance_day_id, enrollment_id)`, CHECK de lunes a viernes, trigger de revisión de uno en uno, lista finalizada inmutable, `marked_at`/`finalized_at` fijados por el servidor, sin borrado físico. Privilegios de `eta15_api` **por columna** (propuesta 0005, aplicada): cualquier columna nueva (p. ej. `device_id` en eventos) exigiría una propuesta de privilegios nueva.

### 2.2 Canal móvil (existe en el sandbox; PR #2)

- Rutas `/mobile/*` sin cookies ni CSRF; **rechazan `Origin`** (`channelGuard`). Autenticación: `Authorization: DPoP <token>` + cabecera `DPoP` (htm, htu, iat, `jti` único, `ath`). Valores del sandbox: acceso 600 s, inactividad 1800 s, sesión absoluta 8 h, tolerancia de reloj de la prueba 60 s.
- `verifyAccess` (por **cada** petición): sesión vigente y ligada a la clave, dispositivo `active`, cuenta y rol vigentes (`mobile_user_eligible`), sin cambio de contraseña pendiente; **roles y permisos se releen de la base**; el `jti` se registra en PostgreSQL (anti-repetición compartido) solo cuando token y clave coinciden.
- Códigos 401 móviles: `UNAUTHENTICATED`, `INVALID_PROOF`, `NONCE_INVALID`, `TOKEN_EXPIRED`, `SESSION_ENDED`, `DEVICE_REVOKED`, `PASSWORD_CHANGE_REQUIRED`; 429 `RATE_LIMITED` con `Retry-After`; 503 `MOBILE_AUTH_UNAVAILABLE`.
- Lecturas escolares ya expuestas por el canal móvil (mismos handlers que el portal): `GET /mobile/school/me/groups` y `GET /mobile/school/groups/:id/roster`.
- **`MOBILE_ALLOWED_PERMISSIONS` = `prefect_assignments:read` y `students:read_basic`.** Un token móvil **no tiene** `attendance:capture`, y **por omisión tampoco `attendance:read` ni existen rutas `/mobile/school/attendance/*`**. Es imposible enviar asistencia por el canal móvil, a propósito. (Desde la fase 1, §18, existen **solo rutas `GET`** y `attendance:read` con alcance `assigned_groups` **únicamente** si se enciende `mobile.attendanceRead` en el sandbox.)
- Los handlers de asistencia **no son reutilizables tal cual**: `attendanceRoutes` registra todas las rutas con `adminGuard` y CSRF dentro de una sola función; hay que extraer cada ruta (como se hizo con `myGroupsRoute` y `groupRosterRoute`) para registrarla con los guardas móviles.

### 2.3 Android (existe, PR #3; solo debug + sandbox)

- Room v2 cifrada (SQLCipher). `attendance_drafts` (un borrador por perfil, grupo y fecha, con **un solo** `requestId` por borrador «que hoy no se envía»), `attendance_marks` (`status` `NULL|PRESENT|ABSENT`, `markedAtEpochMs`), `roster_snapshots` (`rosterDigest`, `serverSchoolDate`), `profile_sync` (último contacto, fecha escolar confirmada, vigencia, `authState`, marca de agua del reloj).
- El perfil sandbox es `sbx.<deviceId>`; el id local del grupo es `<perfil>.<grupoRemoto>` y el del alumno `<grupoLocal>.<alumnoRemoto>`. `remoteId` del alumno **es el `students.id` del servidor**, el mismo `studentId` que acepta `saveMarks`.
- La huella del padrón (`RosterDigest`) es SHA-256 de `(id, nombre, apellido)` ordenado por id: **incluye nombres**, por lo que corregir un nombre en el servidor se vería como «padrón cambiado».
- `setMark` permite **quitar la marca** (volver a Pendiente). El servidor **no admite** deshacer una marca ya guardada (§6.4).
- No hay HTTP de asistencia en ningún source set (prueba estática); el release no tiene `INTERNET` ni cliente de red.

### 2.4 Inconsistencias encontradas y cómo se resuelven en este diseño

| #   | Hallazgo                                                                                                                              | Resolución                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | El `requestId` local es **uno por borrador**; el servidor liga `requestId` a un **contenido** (mismo id con otro contenido → rechazo) | Un `requestId` **por operación** (§5). El del borrador deja de usarse para esto.                           |
| 2   | Los documentos antiguos hablan de `/school/*` para Android; el canal móvil es `/mobile/school/*` y no tiene asistencia                | Rutas móviles nuevas montadas sobre los **mismos handlers** (§4), con guarda móvil propia.                 |
| 3   | `finalize` no tiene identificador de operación y devuelve `alreadyFinalized` sin autor                                                | Se trata como idempotente **por estado**, y el cliente **compara** el resultado con lo que capturó (§7.3). |
| 4   | Un guardado que no cambia nada (`changed:0`, no replay) **no deja evento**, así que su `requestId` no queda registrado                | Brecha menor conocida: el cliente nunca reutiliza un `opId` con otro contenido (operaciones inmutables).   |
| 5   | `Quitar marca` local vs. `att_records_no_unmark` del servidor                                                                         | Regla de interfaz y de cola (§6.4).                                                                        |
| 6   | La huella del padrón local incluye nombres; el servidor no entrega ninguna huella                                                     | Huella v2 **solo de ids** y, si se aprueba, huella calculada por el servidor (§10).                        |
| 7   | `adminGuard` exige MFA; el canal móvil declara `mfa.required:false`                                                                   | Los handlers se registran con `accessGuard` móvil, **no** con `adminGuard` (§8).                           |

## 3. Modelo de operaciones

Cuatro operaciones distintas, con garantías distintas:

| #   | Operación                           | Dónde ocurre             | Efecto en el servidor                     | Idempotencia                                           |
| --- | ----------------------------------- | ------------------------ | ----------------------------------------- | ------------------------------------------------------ |
| 1   | **Capturar / actualizar borrador**  | Solo en Android (Room)   | Ninguno                                   | n/a. Nunca genera red.                                 |
| 2   | **Consultar estado** de grupo y día | Lectura (`GET`)          | Ninguno                                   | Natural                                                |
| 3   | **Enviar cambios** ordinarios       | `POST …/marks` (+ abrir) | Cambia renglones, `revision + 1`, eventos | **Por `requestId` + huella de contenido** (ya existe)  |
| 4   | **Finalizar** la lista              | `POST …/finalize`        | `draft → finalized` (irreversible)        | Por **estado** (`alreadyFinalized`); acción **humana** |

Reglas:

- Capturar **no** envía. Enviar **no** finaliza. Finalizar es una acción **explícita y humana**, nunca automática ni encadenada al envío: una lista finalizada es inmutable y una finalización equivocada solo se corrige con un flujo institucional que **no existe** (`attendance:correct` bloqueado).
- «Abrir» (`POST /days`) es una lectura-o-creación: no es una operación de la cola. Se ejecuta como paso previo de enviar y **siempre con `attendanceDate` = fecha del borrador** (contraste), para que el servidor nunca cree «la lista de hoy» con marcas de otro día.
- Orden de una sincronización de un grupo: `STATUS (consultar)` → `OPEN` si no hay lista → comparar padrón → `SAVE_MARKS` (en serie) → mostrar resultado. `FINALIZE` solo por decisión de la persona.

## 4. Contratos HTTP propuestos (NO implementados)

**Reutilización.** El backend actual ya cubre las cuatro operaciones; se propone **exponer por el canal móvil los mismos handlers y servicios**, sin endpoints duplicados ni lógica de dominio nueva:

| Operación                  | Ruta móvil propuesta                                 | Handler existente reutilizado |
| -------------------------- | ---------------------------------------------------- | ----------------------------- |
| Estado del día de hoy      | `GET /mobile/school/attendance/today`                | `service.today`               |
| Estado de un día/grupo     | `GET /mobile/school/attendance/days?groupId&from&to` | `service.list` (sin nombres)  |
| Detalle y padrón del día   | `GET /mobile/school/attendance/days/:id`             | `service.get`                 |
| Abrir o recuperar          | `POST /mobile/school/attendance/days`                | `service.open`                |
| Enviar marcas              | `POST /mobile/school/attendance/days/:id/marks`      | `service.saveMarks`           |
| Finalizar (fase posterior) | `POST /mobile/school/attendance/days/:id/finalize`   | `service.finalize`            |

**No se expone** `GET …/events` (el historial queda en el portal) ni ninguna ruta administrativa. Un envío **por lotes** no se propone: son pocos grupos por prefecta y un guardado por grupo (≤ 200 marcas) cabe en una petición; un lote añadiría semántica parcial. Se reevaluará si las mediciones lo exigen.

**Autenticación y encabezados** (todas): `Authorization: DPoP <accessToken>`; `DPoP: <prueba firmada con htm, htu, iat, jti nuevo y ath>`; `Content-Type: application/json` en `POST`; **sin** `Origin`, cookies ni `X-CSRF-Token`. Respuestas con `Cache-Control: no-store`.

### 4.1 Abrir o recuperar

```http
POST /mobile/school/attendance/days
{ "groupId": "<uuid remoto>", "attendanceDate": "2026-10-28" }
```

- `201` `{ day, created:true }` | `200` `{ day, created:false }` (misma lista para todas las personas con acceso). `day` = detalle con `id`, `revision`, `status`, `records[]`, `editable`, `schoolToday`, `discrepancies`.
- `400 DATE_NOT_TODAY` (la fecha del borrador no es la de hoy del servidor: **no se crea nada**), `404` (grupo fuera de alcance o inexistente), `409 NOT_SCHOOL_DAY|GROUP_INACTIVE|OUT_OF_YEAR|EMPTY_ROSTER|ROSTER_CHANGED|CONCURRENT`, `403`, `401` móviles, `429`, `503`.

### 4.2 Enviar marcas

```http
POST /mobile/school/attendance/days/<dayId>/marks
{
  "expectedRevision": 3,
  "requestId": "<opId uuid de la operación>",
  "marks": [ { "studentId": "<uuid>", "status": "present" }, { "studentId": "<uuid>", "status": "absent" } ]
}
```

- **Éxito**: `200` `{ day, changed, replayed:false }`.
- **Repetida** (la misma operación ya se aplicó): `200` `{ day, changed:0, replayed:true }` con el estado **vigente**.
- **Conflicto de revisión**: `409 REVISION_CONFLICT` (nada se escribió). **Misma operación con otro contenido**: `409 IDEMPOTENCY_MISMATCH`. **Lista finalizada**: `409 DAY_FINALIZED`. **Día anterior**: `409 DAY_NOT_CURRENT`. **Alumno ajeno al padrón congelado**: `400 STUDENT_NOT_IN_LIST` (toda la petición rechazada). **Sin acceso**: `404` (indistinguible de «no existe») o `403` sin permiso.
- **Estado de sincronización**: el cliente lo deriva de la respuesta, no de un campo nuevo: `200` ⇒ `ACKNOWLEDGED` (con `replayed` para estadística); los `409/400/404` ⇒ §11.
- **Identificador de operación**: es el propio `requestId` (se devuelve en el evento del servidor, no en el cuerpo; el cliente ya lo conoce).

### 4.3 Finalizar (fase posterior)

`POST …/finalize` `{ "expectedRevision": N }` → `200 { day, alreadyFinalized }`; `409 REVISION_CONFLICT|PENDING_RECORDS|EMPTY_ROSTER|DAY_NOT_CURRENT|GROUP_INACTIVE`. Ver §7.3 para `alreadyFinalized:true`.

### 4.4 `requestId` del cuerpo frente a `Idempotency-Key` HTTP

|                           | `requestId` (existente)                                   | `Idempotency-Key` (cabecera)                                                                                                                                                                              |
| ------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Estado                    | Implementado y probado                                    | **Borrador del IETF** (`draft-ietf-httpapi-idempotency-key-header`; la última versión que encontré es la 07, de octubre de 2025, ya vencida; **no vi un RFC**; verificar en Datatracker antes de citarla) |
| Alcance de la clave       | Por lista (índice único `(day, request_id, record)`)      | Por cliente y recurso, definido por el servidor                                                                                                                                                           |
| Verificación de contenido | Sí: `payload_hash`; distinto → `409 IDEMPOTENCY_MISMATCH` | El borrador sugiere `422` ante otro contenido                                                                                                                                                             |
| Cubre `finalize`          | No                                                        | Sería genérica                                                                                                                                                                                            |

**Recomendación técnica provisional**: **conservar `requestId`** (no añadir una segunda clave que habría que mantener coherente). Revisar la cabecera estándar solo si se estandariza y si se quiere cubrir `finalize` con la misma mecánica.

### 4.5 Cambios de backend (resumen; ninguno se hace ahora)

| #   | Cambio                                                                                                                                                                                   | ¿Migración / privilegios?                                | Prioridad                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| B1  | Extraer cada ruta de asistencia a una función exportable y registrar el subconjunto móvil con `accessGuard` (sin `adminGuard`/CSRF)                                                      | No                                                       | Necesario                                             |
| B2  | Añadir `attendance:capture` y `attendance:read` a `MOBILE_ALLOWED_PERMISSIONS`, **detrás de un interruptor de configuración desactivado por defecto** y con revisión de seguridad propia | No                                                       | Necesario                                             |
| B3  | Registrar `deviceId` y el canal en el **audit** de asistencia (`recordAudit.details`), sin tocar `attendance_events`                                                                     | No                                                       | Recomendado                                           |
| B4  | Publicar en `shared-contracts` el catálogo de `reason` como contrato móvil (hoy solo vive en el servicio)                                                                                | No                                                       | Necesario                                             |
| B5  | Añadir `rosterDigest` (SHA-256 de ids ordenados) al detalle de la lista y al padrón descargado, **calculado al vuelo**                                                                   | No                                                       | Recomendado                                           |
| B6  | `finalizedByMe` (booleano) en la respuesta de `finalize`/detalle, sin revelar identidades                                                                                                | No                                                       | Opcional                                              |
| B7  | `device_id` (nullable) en `attendance_events` y/o libro de operaciones (`attendance_operations`) para idempotencia de `finalize` y de los guardados sin cambios                          | **Sí**: migración y propuesta de privilegios por columna | Solo si la escuela exige trazabilidad por dispositivo |
| B8  | Captura tardía / corrección: **ningún cambio hasta que la escuela decida** (§9, §16)                                                                                                     | —                                                        | Bloqueado                                             |

## 5. Identidad de las operaciones

| Identidad                 | Qué es                                                                           | Quién la genera       | Vida                                     | ¿Estable en reintentos?       |
| ------------------------- | -------------------------------------------------------------------------------- | --------------------- | ---------------------------------------- | ----------------------------- |
| `draftId` (local)         | Borrador de un grupo y fecha en Room                                             | Android               | Hasta purga del perfil                   | Sí                            |
| **`opId`**                | Una **operación lógica** inmutable (un conjunto de marcas)                       | Android, al sellarla  | Hasta `ACKNOWLEDGED` o reemplazo         | **Sí: es el `requestId`**     |
| `requestId` de asistencia | `opId` enviado en el cuerpo; clave de idempotencia de negocio                    | = `opId`              | Eterna en `attendance_events`            | **Sí**                        |
| Id de petición HTTP       | Un intento de red concreto (el servidor lo genera: aparece en `error.requestId`) | Servidor              | Una petición                             | No                            |
| `jti` DPoP                | Prueba criptográfica **de una sola petición**                                    | Android, por petición | ≤ 15 min en PostgreSQL (anti-repetición) | **No: nuevo en cada intento** |
| `dayId`                   | `attendance_days.id`                                                             | Servidor              | Permanente                               | Sí                            |
| `revision`                | Contador optimista de la lista                                                   | Servidor              | Monótono                                 | Cambia con cada guardado      |

**Idempotencia de negocio ≠ antirrepetición criptográfica.** El `jti` impide que un tercero **repita una petición capturada** (la segunda se rechaza `401 INVALID_PROOF`). El `requestId` hace que **la misma intención del usuario** no se aplique dos veces aunque el cliente reenvíe. Son capas distintas:

- Petición que **llegó** pero cuya respuesta se perdió → el cliente **reenvía con el mismo `requestId` y un `jti` nuevo**; el servidor responde `replayed:true` y nada se duplica.
- Reenviar **la misma petición HTTP con el mismo `jti`** nunca se hace: sería rechazada (`INVALID_PROOF`) y se contaría como fallo de credenciales.
- Reutilizar un `requestId` con **otro contenido** → `409 IDEMPOTENCY_MISMATCH` y **nunca** se reintenta: se marca `NEEDS_REVIEW` (es un defecto del cliente).

**Identificación estable del contenido lógico.** La huella es la del servidor: `SHA-256( join("|", sort_por_studentId( "<studentId>:<status>" )) )` con `studentId` en **minúsculas** (el servidor hashea la cadena recibida) y `status` en `present|absent`. Android la calcula con la **misma función** y la guarda (`contentHash`) para detectar corrupción local antes de enviar. **`expectedRevision` no forma parte de la huella** y **es un parámetro de transporte, no del contenido**: puede cambiar entre intentos sin cambiar la operación.

Consecuencias verificadas en el código:

1. Tras un `409 REVISION_CONFLICT` (no se escribió nada) el cliente puede reenviar **el mismo `opId`** con una `expectedRevision` refrescada: el servidor no lo vio.
2. Si la operación **sí** se aplicó y se perdió la respuesta, reenviarla con una `expectedRevision` **vieja** funciona igual: la comprobación de repetición va **antes** que las de revisión, fecha y estado.
3. Una operación **no se edita jamás** después de sellarse. Si el contenido debe cambiar (p. ej. quitar un alumno ajeno al padrón), se crea una **operación derivada** con un `opId` nuevo y `supersedes = opId anterior`.

## 6. Cola local (outbox) propuesta en Room — NO implementada

Sería la **versión 3** del esquema, con migración aditiva (sin `fallbackToDestructiveMigration`, sin `REPLACE`), cifrada como el resto. Nombres ajustables.

### 6.1 Tablas

`sync_operations` (una fila inmutable por operación):

| Columna                                      | Contenido                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `opId` (PK, uuid)                            | = `requestId` de asistencia                                                                |
| `profileId`, `deviceId`                      | Perfil `sbx.<deviceId>` y dispositivo que la creó (el servidor valida su propia identidad) |
| `groupId`, `remoteGroupId`                   | Grupo local y remoto                                                                       |
| `schoolDate`                                 | Fecha escolar del borrador (**nunca se «mueve»**)                                          |
| `kind`                                       | `SAVE_MARKS` o `FINALIZE`                                                                  |
| `seq`                                        | Orden causal **por (perfil, grupo, fecha)**, creciente                                     |
| `contentHash`                                | Misma huella que el servidor (solo `SAVE_MARKS`)                                           |
| `state`, `reasonCode`                        | Estado (§6.2) y motivo estable                                                             |
| `attempts`, `lastAttemptAt`, `nextAttemptAt` | Reintentos                                                                                 |
| `lastHttpStatus`, `lastServerCode`           | Resultado del servidor (**solo** código y estado; nunca mensajes con datos)                |
| `serverDayId`, `knownRevision`               | Lista remota y revisión usada/conocida                                                     |
| `rosterDigestAtCapture`                      | Huella del padrón con que se capturó (v2: solo ids)                                        |
| `supersedesOpId`                             | Operación a la que reemplaza                                                               |
| `createdAt`, `updatedAt`, `ackedAt`          | Fechas locales **informativas** (no autoridad)                                             |

`sync_operation_marks` (PK `(opId, remoteStudentId)`, FK `ON DELETE CASCADE` a la operación): `remoteStudentId`, `status` (`present|absent`). **Es el payload mínimo**: ids y estado, sin nombres.

`sync_day_state` (PK `(profileId, groupId, schoolDate)`): `serverDayId`, `serverStatus`, `knownRevision`, `serverRosterDigest`, `lastCheckedAt`, `serverSchoolDate`.

`sync_acked_marks` (PK `(profileId, groupId, schoolDate, remoteStudentId)`): último estado **confirmado** por el servidor para cada alumno (sirve para calcular el delta y para mostrar diferencias).

Restricciones y aislamiento:

- Todas las tablas llevan `profileId` con FK compuesta al grupo del **mismo** perfil (como `attendance_marks`): la cola **no puede contener datos de otro perfil**.
- Disparadores en `onOpen` (como los existentes): `state` válido; **una sola operación `SENDING` por (perfil, grupo, fecha)** (Room no expresa índices parciales; se impone con trigger y en la transacción); una operación **sellada no cambia de contenido** (`UPDATE` de `sync_operation_marks` prohibido).
- **Sin credenciales**: ni tokens, ni refresh, ni jti, ni claves. La sesión móvil vive en memoria; la cola solo guarda ids, estados y marcas.

### 6.2 Estados

`LOCAL_ONLY` (nivel borrador: hay marcas sin sellar) · `READY` · `SENDING` · `ACKNOWLEDGED` · `RETRYABLE_ERROR` · `CONFLICT` · `NEEDS_REVIEW` · `AUTH_REQUIRED` · `SUPERSEDED` (terminal) · `DISCARDED` (terminal, **solo** por decisión explícita de la persona, con confirmación).

```
LOCAL_ONLY --sellar--> READY --enviar--> SENDING --200--> ACKNOWLEDGED
                          ^                  |--sin respuesta/429/503/5xx--> RETRYABLE_ERROR --backoff--> READY
                          |                  |--401 renovable/sesión--> AUTH_REQUIRED --sesión nueva--> READY
                          |                  |--409 REVISION_CONFLICT--> CONFLICT --resolver--> (derivada) READY
                          |                  '--400/403/404/409 no reintentable--> NEEDS_REVIEW
 proceso interrumpido en SENDING ----------> RETRYABLE_ERROR (resultado desconocido: se reenvía el mismo opId)
```

`reasonCode` (estable, en inglés técnico): `NETWORK`, `TIMEOUT`, `RATE_LIMITED`, `SERVER_UNAVAILABLE`, `TOKEN_EXPIRED`, `SESSION_ENDED`, `DEVICE_REVOKED`, `ACCOUNT_BLOCKED`, `REVISION_CONFLICT`, `SERVER_MARK_DIFFERS`, `DAY_FINALIZED`, `DAY_NOT_CURRENT`, `DATE_NOT_TODAY`, `STUDENT_NOT_IN_LIST`, `ACCESS_LOST_OR_NOT_FOUND`, `IDEMPOTENCY_MISMATCH`, `ROSTER_DIFFERS`, `UNMARK_AFTER_ACK`, `INVALID_PAYLOAD`.

### 6.3 Atomicidad entre marcar y encolar

- `setMark` **no crea operaciones**: sigue escribiendo solo `attendance_marks` (captura rápida, un toque, sin I/O de cola) y deja el borrador como `LOCAL_ONLY`.
- Las operaciones se **sellan** en una sola transacción de Room (`withTransaction`): leer las marcas del borrador, calcular el **delta** frente a `sync_acked_marks` (solo marcas con estado distinto del confirmado), insertar `sync_operations` + `sync_operation_marks` con `seq = max+1` y calcular `contentHash`. O queda todo o nada: no hay operación sin marcas ni marcas sin operación.
- Sellar ocurre al iniciar una sincronización o al pulsar «Enviar»; las marcas posteriores forman la operación **siguiente**. Esto evita una operación por toque y mantiene cada operación inmutable.
- Un fallo de envío **nunca** toca `attendance_marks`: el borrador sigue completo y editable.

### 6.4 Regla del «quitar marca»

El servidor no permite volver a Pendiente. Por eso, para un alumno con estado **confirmado** en `sync_acked_marks`, la interfaz solo permite **cambiar entre Presente y Ausente**; «Quitar marca» se deshabilita (con explicación). Si aun así una marca local confirmada queda en `NULL` (p. ej. por una versión anterior), el delta la marca `UNMARK_AFTER_ACK` → `NEEDS_REVIEW` y **no se envía**.

### 6.5 Retención

Tras `ACKNOWLEDGED` **no se borra nada de inmediato**. Se conservan operaciones y marcas hasta que (a) la lista esté finalizada en el servidor y (b) pase la ventana de retención que la escuela decida (§16 B-5), o la persona purgue el perfil. Mientras tanto la interfaz muestra «Confirmado por el servidor», no «borrado».

## 7. Versionado y concurrencia

### 7.1 Una sola operación en vuelo por lista

Por (perfil, grupo, fecha) se envía **una operación a la vez**, en orden de `seq`; la siguiente espera a que la anterior esté `ACKNOWLEDGED` o `SUPERSEDED`. La `expectedRevision` de la operación _n+1_ es la `revision` devuelta en el `200` de la operación _n_. Eso hace imposible que un mismo dispositivo entregue dos operaciones de la misma lista en orden inverso; si ocurriera (error de programación), la `expectedRevision` desactualizada produce `409 REVISION_CONFLICT` y no un resultado distinto.

### 7.2 Revisión y conflicto

El servidor compara `expectedRevision` con `revision` bajo `FOR UPDATE`. Un `409 REVISION_CONFLICT` significa «alguien cambió la lista» (otra prefecta con cobertura, la web o **otro dispositivo propio**). El cliente: (1) consulta el detalle; (2) compara por alumno **lo que el servidor tiene** frente a **lo que va en la operación**:

- alumno **pendiente** en el servidor o con **el mismo estado** → no hay conflicto real;
- alumno con **otro estado** ya confirmado → **conflicto de contenido**: se muestra a la persona (servidor / mi captura) y **ella decide**; nunca gana el último.

Solo si **todos** los renglones de la operación están en el primer caso, el cliente puede reenviar **el mismo `opId`** con la revisión refrescada (**automático**, decisión técnica provisional §16 A-3). Con cualquier diferencia → `CONFLICT`/`NEEDS_REVIEW` (la persona decide; si elige su valor, se crea una operación derivada que el servidor volverá a validar; el servidor mantiene su historial de cambios).

### 7.3 Finalización

- Solo si el servidor reporta cero pendientes **y** toda operación del grupo está `ACKNOWLEDGED`, la interfaz ofrece «Finalizar» y la persona lo confirma.
- `finalize` compite con `saveMarks` serializado por el bloqueo de la lista: gana el primero; el otro recibe `409 REVISION_CONFLICT` o `409 DAY_FINALIZED`.
- `200 alreadyFinalized:true` **no prueba que la finalizó este dispositivo**. El cliente **compara** `records[]` con sus marcas confirmadas: si coinciden, «Lista finalizada» (quizá por otra persona, sin revelar quién); si difieren → `NEEDS_REVIEW` con motivo `SERVER_MARK_DIFFERS`. No se intenta modificar una lista finalizada.

## 8. Autorización y revocaciones

Cada intento de envío debe pasar **todas** las comprobaciones en el servidor (marcadas ✔ cuando ya existen):

| Comprobación                                                                   | Dónde                                               | Estado                                       |
| ------------------------------------------------------------------------------ | --------------------------------------------------- | -------------------------------------------- |
| Prueba DPoP válida, `htm`/`htu`/`ath`, `jti` no repetido                       | `accessGuard` + `recordProof` (PostgreSQL)          | ✔                                            |
| Sesión móvil vigente y ligada a la clave                                       | `verifyAccess`                                      | ✔                                            |
| Dispositivo `active`                                                           | `verifyAccess` (`device_revoked`)                   | ✔                                            |
| Cuenta elegible, rol de prefectura vigente, sin cambio de contraseña pendiente | `mobile_user_eligible`, `user_roles`                | ✔                                            |
| Permisos y alcance leídos **de la base**, no del cliente                       | `verifyAccess` (re-lee `role_permissions`)          | ✔ (falta incluir los de asistencia: B2)      |
| `attendance:capture` con `assigned_groups` y asignación **vigente hoy**        | `resolveAccess` + `lockGroupAccess` (`FOR SHARE`)   | ✔                                            |
| Grupo activo y dentro del ciclo; fecha escolar; lista en borrador              | `saveMarks`/`open`                                  | ✔                                            |
| `userId`, alcance, fecha o actor declarados por el cliente                     | Contratos Zod estrictos: **no existen** esos campos | ✔ (se mantiene: ningún DTO nuevo los admite) |

La autorización con que se descargó el padrón **no se reutiliza**: se vuelve a evaluar en cada petición.

**Prefecta que capturó estando autorizada y perdió el grupo antes de reconectar.** Propuesta **conservadora**: el servidor responde `404` (indistinguible); el cliente marca la operación `NEEDS_REVIEW` (`ACCESS_LOST_OR_NOT_FOUND`), consulta la lista de grupos para confirmar que el grupo ya no aparece (`GROUP_REVOKED`, estado que Android ya conoce) y **conserva el borrador** bloqueado. **No se acepta por el flujo ordinario ni se implementa excepción alguna.** Alternativas (decisión B-3, §16): revisión por Dirección sobre la evidencia local, descarte con acta, o captura tardía supervisada.

Caso límite: una operación que **sí se aplicó** pero cuya respuesta se perdió, y cuyo acceso se retiró **antes** del reenvío, recibe `404` (el control de acceso va antes que la comprobación de repetición). Su resultado es **desconocido**: el cliente la deja en `NEEDS_REVIEW` con ese texto exacto («no se pudo confirmar si el servidor la recibió») y nunca la da por perdida ni por aplicada.

**Dispositivo revocado / cuenta bloqueada / sesión terminada**: `DEVICE_REVOKED` y `ACCOUNT_BLOCKED` ⇒ todas las operaciones `AUTH_REQUIRED` (no reintentables) y el perfil se bloquea (ya implementado); `TOKEN_EXPIRED` ⇒ renovar y reintentar; `SESSION_ENDED` ⇒ abrir sesión nueva con la clave del dispositivo (ver A-5: si debe exigir presencia de la persona). Los borradores y la cola **se conservan**; no hay borrado remoto.

## 9. Fecha escolar y medianoche

**Cinco relojes que no hay que confundir:**

| Concepto                                           | Quién lo decide                           | Uso                                              |
| -------------------------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| Fecha escolar del servidor (`schoolToday`)         | Servidor (`America/Mazatlan`)             | **Única** que decide dónde cae una captura       |
| Fecha mostrada en Android                          | Android (reloj + última fecha confirmada) | Interfaz; borrador `schoolDate`                  |
| Momento local de captura (`markedAt`, `createdAt`) | Reloj del teléfono                        | **Solo informativo**; no se envía como autoridad |
| Momento de recepción                               | Servidor (`occurred_at`, `marked_at`)     | Historial                                        |
| Última validación / vigencia offline               | Servidor + Android                        | Acceso offline (hoy 30 min, solo sandbox)        |

**Reglas del envío** (el backend **no cambia** su política):

1. La operación se envía **solo** si `schoolDate` del borrador **== `schoolToday` del servidor** (leído en `GET /today` justo antes). El cliente **nunca** envía a un `dayId` cuya `attendanceDate` difiera de la del borrador.
2. `open` lleva siempre `attendanceDate`: un cliente con el reloj atrasado/adelantado no puede crear «la lista de hoy» con datos de otro día (`400 DATE_NOT_TODAY`).
3. Si la fecha ya no coincide → `NEEDS_REVIEW` con `DATE_NOT_TODAY`/`DAY_NOT_CURRENT` y se muestra «Captura histórica bloqueada». **No se intenta, no se «mueve» a hoy, no se borra.**
4. La repetición de una operación **ya aplicada** sí se acepta tras medianoche (la comprobación de `requestId` precede a la de fecha): recuperar una respuesta perdida **no** es captura tardía.

**Casos obligatorios**

| Caso                                       | Resultado esperado                                                                                                                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Captura y envío el mismo día               | `OPEN` (si no hay lista) → `SAVE_MARKS` → `ACKNOWLEDGED`.                                                                                                                                                                  |
| Captura antes de medianoche, envío después | Operaciones aún no aplicadas → `NEEDS_REVIEW` (`DATE_NOT_TODAY`/`DAY_NOT_CURRENT`), borrador intacto. Una operación aplicada cuya respuesta se perdió → `replayed:true` (se acepta).                                       |
| Fin de semana                              | Android no crea borradores; el servidor responde `409 NOT_SCHOOL_DAY`.                                                                                                                                                     |
| Teléfono con reloj alterado                | El servidor ignora la hora del cliente. Reloj atrasado: se detecta `CLOCK_SUSPECT` (ya implementado) y se bloquea. Reloj **adelantado** puede etiquetar con «mañana» una captura de hoy: ver mitigación abajo.             |
| Dispositivo sin conexión varias horas      | La vigencia offline caduca (hoy 30 min en sandbox): se **bloquean nuevas consultas y capturas**; lo ya sellado se conserva y se envía al reconectar según estas reglas.                                                    |
| Vigencia offline vencida                   | Bloquea lectura/captura locales; **no** borra borradores ni operaciones; para enviar se requiere sesión móvil vigente y fecha coincidente. Si lo ya capturado debe poder enviarse tras vencer la vigencia es decisión B-1. |

**Mitigación del reloj adelantado (propuesta técnica A-4).** Para que una captura de hoy no se etiquete con otra fecha, Android debe derivar `schoolDate` de la **última fecha escolar confirmada por el servidor + tiempo monotónico transcurrido** (`elapsedRealtime`), no del reloj de pared, y compararlo con el reloj de pared (la marca de agua actual sigue). Tras un **reinicio** del teléfono el tiempo monotónico se pierde: la fecha queda **no confirmada** y la captura/envío exigen reconectar. Un borrador cuya fecha no se pueda confirmar no se envía; si al reconectar coincide con la del servidor se acepta, con el riesgo residual (documentado) de que el reloj haya estado adelantado dentro de la vigencia.

**Qué hacer con lo que llega tarde (decisión B-2, §16).** El diseño técnico es el mismo para todas las alternativas: la operación queda en `NEEDS_REVIEW` con `DATE_NOT_TODAY`, conservada y visible; lo que cambia es **quién** y **por qué canal** la resuelve.

## 10. Padrón histórico

**Identificadores**: ciclo (`schoolYearId`), grupo (`groupId`), matrícula (`enrollment_id`, solo en el servidor), alumno (`students.id` = `remoteStudentId` en Android), lista (`dayId`), padrón de la lista = `attendance_records` **congelados al abrir** (el padrón real para esa fecha), fecha de referencia = `attendanceDate` de la lista.

**Relación con el snapshot local.** El snapshot de Android (`roster_snapshots`) es el padrón **descargado en algún momento**; la lista del servidor puede haberse abierto después (por otra persona o dispositivo) con un padrón distinto. La **única comparación válida** es contra los renglones de la lista:

1. Antes de enviar, `GET …/days/:id` y comparar el **conjunto de `studentId`** de `records[]` con el conjunto de alumnos del borrador (nunca por nombre).
2. Marcas de alumnos **ausentes** en la lista del servidor → no se envían: se crea una operación derivada sin ellos y la original queda `SUPERSEDED`; los ausentes pasan a `NEEDS_REVIEW` (`STUDENT_NOT_IN_LIST`). (Si se enviaran, el servidor rechazaría **toda** la petición con `400`.)
3. Alumnos **en la lista pero no en el borrador** → quedan pendientes; el cliente **no inventa** marcas.
4. Android **jamás agrega alumnos** a una lista: el servidor tampoco lo admite (padrón congelado, `STUDENT_NOT_IN_LIST`).

| Caso                                | Detección                                                                          | Acción                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Alumno recién incorporado           | Está en el padrón actual, no en la lista congelada (`discrepancies.addedToRoster`) | Se informa; no se agrega (decisión institucional §3.9 del diseño de asistencia).                         |
| Transferencia entre grupos          | Alumno fuera del padrón del grupo A; puede aparecer en B                           | Solo se envía lo que está en la lista de cada grupo; posible doble presencia el mismo día: decisión B-4. |
| Baja de alumno                      | `discrepancies.removedFromRoster`                                                  | La lista conserva el renglón (no se elimina); informativo.                                               |
| Cambio de ciclo                     | `schoolYearId` del grupo distinto / grupo ausente al descargar                     | Grupo `REVOKED` o nuevo grupo; borradores de grupos que ya no están se conservan y se marcan.            |
| Padrón descargado parcialmente      | No ocurre: la descarga es **todo o nada** y valida cantidades                      | Un fallo deja la caché anterior intacta.                                                                 |
| Padrón congelado en lista existente | `records[]` del detalle                                                            | **Fuente de verdad** para la comparación; no se actualiza automáticamente.                               |
| Lista finalizada                    | `status = finalized`                                                               | **No se modifica ni se actualiza**; el cliente solo muestra lo que el servidor tiene.                    |

**Datos mínimos para detectar cambios sin exponer expedientes**: conjuntos de `studentId`, conteos y una **huella de ids**. Nombres no hacen falta. **Se propone** (a) huella v2 en Android calculada **solo sobre ids** (evita falsos positivos por correcciones de nombre) y (b) **`rosterDigest` calculado por el servidor** (SHA-256 de ids ordenados, al vuelo, sin columna) tanto en el padrón descargado como en el detalle de la lista (B5): así se compara «padrón descargado» con «padrón de esa lista» sin inventar versiones. Una marca ya confirmada **nunca** se elimina de la historia: los cambios de padrón no tocan eventos.

## 11. Conflictos

Política: **sin _last-write-wins_**; no se sobrescribe en silencio; no se modifican listas finalizadas; no se duplican eventos; no se borran borradores; los conflictos institucionales **no** se resuelven automáticamente.

| #   | Caso                                                      | Señal del servidor                                                       | Acción del cliente                                                                                                                              | ¿Automático?               | Estado                             |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------- |
| 1   | No existe lista en el servidor                            | `open` → `201`                                                           | Crear la lista con `attendanceDate` del borrador; si el padrón difiere, comparar (§10).                                                         | Sí                         | `READY` → `SENDING`                |
| 2   | Lista `draft` sin cambios desde la revisión conocida      | `revision` igual                                                         | Enviar.                                                                                                                                         | Sí                         | `ACKNOWLEDGED`                     |
| 3   | Lista `draft` modificada por otra prefecta                | `409 REVISION_CONFLICT`                                                  | Consultar detalle; solo pendientes/iguales → reenviar mismo `opId`; estados distintos → mostrar y que decida la persona.                        | Solo si no hay diferencias | `CONFLICT` / `NEEDS_REVIEW`        |
| 4   | Lista `finalized`                                         | `409 DAY_FINALIZED`                                                      | No reintentar; mostrar el estado del servidor y diferencias.                                                                                    | No                         | `NEEDS_REVIEW` (`DAY_FINALIZED`)   |
| 5   | La misma operación ya se aplicó                           | `200 replayed:true`                                                      | Marcar confirmada; adoptar el estado vigente.                                                                                                   | Sí                         | `ACKNOWLEDGED`                     |
| 6   | Mismo `requestId` con otro contenido                      | `409 IDEMPOTENCY_MISMATCH`                                               | **No reintentar**; es un defecto: conservar y avisar.                                                                                           | No                         | `NEEDS_REVIEW`                     |
| 7   | La prefecta perdió el grupo                               | `404` (o `403`)                                                          | Confirmar con la lista de grupos; bloquear el grupo; conservar el borrador.                                                                     | No                         | `NEEDS_REVIEW` (`ACCESS_LOST…`)    |
| 8   | Dispositivo revocado                                      | `401 DEVICE_REVOKED`                                                     | Bloquear el perfil; conservar todo; sin reintentos.                                                                                             | No                         | `AUTH_REQUIRED` (`DEVICE_REVOKED`) |
| 9   | El alumno cambió de grupo                                 | `400 STUDENT_NOT_IN_LIST` o `discrepancies`                              | Derivar operación sin ese alumno; el alumno a revisión.                                                                                         | Derivación sí; decisión no | `SUPERSEDED` + `NEEDS_REVIEW`      |
| 10  | El padrón fue actualizado                                 | Detalle: `records[]` ≠ borrador                                          | Comparar por ids; enviar solo lo común; marcar diferencias.                                                                                     | Parcial                    | `NEEDS_REVIEW` (`ROSTER_DIFFERS`)  |
| 11  | El envío llega al día siguiente                           | `400 DATE_NOT_TODAY` / `409 DAY_NOT_CURRENT`                             | No «mover» la captura; conservar; mostrar «captura histórica bloqueada»; decisión B-2. (Una repetición ya aplicada sí se acepta.)               | No                         | `NEEDS_REVIEW`                     |
| 12  | Dos dispositivos envían simultáneamente                   | Uno `200`, el otro `409 REVISION_CONFLICT`                               | El segundo aplica la regla del caso 3. Dos dispositivos propios generan `opId` distintos; el servidor los serializa por el bloqueo de la lista. | Según caso 3               | `CONFLICT`                         |
| 13  | El servidor guarda pero la respuesta se pierde            | (sin respuesta)                                                          | Reenviar **mismo `opId`**, `jti` nuevo → `replayed:true`.                                                                                       | Sí                         | `RETRYABLE_ERROR` → `ACKNOWLEDGED` |
| 14  | La conexión cae antes de guardar                          | (sin respuesta; nada escrito)                                            | Igual que el 13: el reenvío se aplica normalmente (o entra en conflicto).                                                                       | Sí                         | `RETRYABLE_ERROR` → …              |
| 15  | Dos operaciones de la misma lista llegan en orden inverso | Segunda con `expectedRevision` vieja → `409`                             | Evitado por «una en vuelo» (§7.1); si ocurriera, no corrompe: es un conflicto de revisión.                                                      | —                          | `CONFLICT`                         |
| 16  | Una finalización compite con el guardado                  | Uno gana por el bloqueo; el otro `409 REVISION_CONFLICT`/`DAY_FINALIZED` | Si el guardado pierde: caso 4. Si la finalización pierde: reevaluar y decidir la persona.                                                       | No                         | `NEEDS_REVIEW`/`CONFLICT`          |

**Reintentos sin intervención**: casos 1, 2, 5, 13, 14, la reapertura de sesión por `TOKEN_EXPIRED`, y el reenvío del caso 3 **solo** cuando no hay diferencias. **Requieren intervención**: 4, 6, 7, 8, 9, 10, 11, 16 y cualquier estado distinto en el caso 3.

## 12. Estados del cliente (pantallas y mensajes)

Nada se presenta como éxito hasta recibir el `200`. Mensajes propuestos (es-MX), nunca «Sincronizada» antes del ACK:

| Estado                      | Texto propuesto                                                   | Acción ofrecida                       |
| --------------------------- | ----------------------------------------------------------------- | ------------------------------------- |
| `LOCAL_ONLY` / `READY`      | «Guardada en este dispositivo. Pendiente de envío.»               | Enviar ahora                          |
| `SENDING`                   | «Enviando…» (indicador de progreso; no bloquea la captura)        | —                                     |
| `ACKNOWLEDGED`              | «Confirmada por el servidor» (con hora del servidor)              | Finalizar (si procede)                |
| `RETRYABLE_ERROR`           | «No se pudo enviar. Se reintentará; sus datos siguen guardados.»  | Reintentar ahora                      |
| `CONFLICT`                  | «Otra persona modificó esta lista. Revise las diferencias.»       | Ver diferencias y elegir              |
| `AUTH_REQUIRED` (sesión)    | «Sesión caducada. Vuelva a iniciar la sesión del dispositivo.»    | Abrir sesión                          |
| `AUTH_REQUIRED` (revocado)  | «Acceso revocado. Sus capturas se conservan en este dispositivo.» | Contactar a Dirección                 |
| `NEEDS_REVIEW` (padrón)     | «El padrón cambió. Revise a los alumnos señalados.»               | Revisar                               |
| `NEEDS_REVIEW` (fecha)      | «Captura histórica bloqueada: la fecha escolar ya pasó.»          | Conservar; ver opciones de la escuela |
| `NEEDS_REVIEW` (finalizada) | «La lista ya fue finalizada. No se puede modificar.»              | Ver lo registrado                     |

Resumen por grupo («2 confirmadas, 1 pendiente, 1 por revisar»), estado de conexión y `FLAG_SECURE` se mantienen. **No se borra nada localmente al recibir un ACK**; la limpieza sigue la política de retención (§6.5).

## 13. Reintentos

| Situación                                                                    | ¿Reintentar sola?  | Notas                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sin internet / DNS / conexión rechazada                                      | Sí                 | Esperar conectividad; no cuenta como fallo de credenciales.                                                                                                           |
| Timeout de red / respuesta perdida                                           | Sí                 | **Mismo `opId`, `jti` nuevo.** Resultado desconocido ⇒ el reenvío es seguro por la idempotencia.                                                                      |
| `429`                                                                        | Sí                 | Respetar `Retry-After` si viene; si no, backoff.                                                                                                                      |
| `503` / `5xx` temporal (`MOBILE_AUTH_UNAVAILABLE`, `ATTENDANCE_UNAVAILABLE`) | Sí                 | Backoff; si persiste, `RETRYABLE_ERROR` visible.                                                                                                                      |
| `401 TOKEN_EXPIRED`                                                          | Sí                 | Renovar (con rotación) y reintentar. Si la respuesta de la renovación se pierde, el servidor cierra la sesión (limitación conocida): abrir sesión nueva con la clave. |
| `401 INVALID_PROOF` / `NONCE_INVALID`                                        | Una vez            | Nueva prueba/desafío; si se repite, no insistir (puede indicar reloj o clave).                                                                                        |
| `401 SESSION_ENDED`                                                          | No sola            | Sesión nueva (¿requiere persona?, A-5).                                                                                                                               |
| `401 DEVICE_REVOKED`, cuenta bloqueada                                       | **No**             | Terminal hasta acción administrativa.                                                                                                                                 |
| `403`                                                                        | **No**             | Sin permiso.                                                                                                                                                          |
| `404` (fuera de alcance)                                                     | **No**             | Confirmar con la lista de grupos; `NEEDS_REVIEW`.                                                                                                                     |
| `409` (conflicto, finalizada, fecha, `IDEMPOTENCY_MISMATCH`)                 | **No** sin revisar | Salvo `REVISION_CONFLICT` sin diferencias (§7.2) y `CONCURRENT` (una vez).                                                                                            |
| `400` carga inválida / `STUDENT_NOT_IN_LIST` / `DATE_NOT_TODAY`              | **No**             | Defecto o desajuste: conservar y revisar.                                                                                                                             |

**Fallo de entrega ≠ error HTTP.** Sin respuesta = **resultado desconocido** (puede haberse aplicado): se reenvía el mismo `opId`. Con respuesta HTTP = resultado **conocido**: se aplica la tabla. Nunca se interpreta un timeout como rechazo.

**Backoff**: exponencial con _jitter_ completo (propuesta: base 5 s, factor 2, tope 15 min, hasta 8 intentos antes de pedir intervención; valores de sandbox, a medir). **Restricciones de red**: solo con conectividad validada, sin forzar datos móviles si la política lo prohíbe.

**WorkManager** (fase posterior): trabajo **único por identidad** (`attendance-sync-<profileId>`, `ExistingWorkPolicy.KEEP`), restricción `CONNECTED`, _backoff_ exponencial del sistema como respaldo del propio. Es diferible, no exacto: no garantiza hora. Recuperación tras reinicio: al arrancar, las operaciones `SENDING` pasan a `RETRYABLE_ERROR` (resultado desconocido) y se reenvían con el mismo `opId`. **Primera etapa**: envío manual en primer plano («Enviar ahora» y al reanudar la app), sin trabajos en segundo plano; el release sigue sin `INTERNET` hasta que exista revisión de seguridad.

## 14. Seguridad

- **Tres capas distintas**: TLS en tránsito (release exigirá HTTPS; el sandbox usa HTTP solo hacia `10.0.2.2`), DPoP (token ligado a la clave del dispositivo; anti-repetición `jti` en PostgreSQL) e idempotencia de negocio (`requestId` + huella).
- **Superficie mínima**: solo `today`, `days`, `days/:id`, `open`, `marks`, `finalize` por el canal móvil; sin historial, sin rutas administrativas; `Cache-Control: no-store`; `bodyLimit` y máximos de las rutas actuales; limitación de tasa existente.
- **El servidor no confía en el cliente**: valida pertenencia al padrón congelado, estados permitidos, fecha, permisos y alcance en cada petición; el cliente no envía ni `userId`, ni rol, ni alcance, ni fecha, ni hora.
- **Interruptor y revisión**: `attendance:*` en el token móvil, detrás de configuración apagada por defecto y una revisión de seguridad propia (B2). Hoy una cuenta con rol que exige MFA no es elegible por el canal móvil; eso se mantiene.
- **Trazabilidad**: `deviceId` y canal en auditoría (B3); el historial de eventos ya registra actor y `requestId`. No se exponen identidades de otras prefectas.
- **Dispositivo comprometido**: un teléfono con root podría alterar la cola, pero el servidor revalida todo; el daño se limita a marcar los grupos que esa persona ya puede capturar, con rastro. La falta de atestación y de borrado remoto sigue siendo riesgo abierto.
- **Fugas**: ni la cola ni los registros guardan credenciales; los mensajes de error del servidor no se almacenan; los logs de Android no incluyen nombres (prueba estática existente).
- **Datos reales**: no hasta resolver decisiones institucionales, MFA y ADR 0005.

## 15. Casos de prueba futuros (NINGUNO se ha ejecutado)

Niveles: **U** unitaria JVM / Vitest · **PG** PostgreSQL desechable (`pnpm test:pg-temp`) · **I** instrumentada Room/Keystore · **E2E** emulador + sandbox · **F** inyección de fallos.

| #   | Nivel     | Caso                                                                                                  | Resultado correcto                                                                       |
| --- | --------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | U         | Huella Android = huella del servidor (vectores compartidos)                                           | Mismo SHA-256 para los mismos pares, independiente del orden de entrada                  |
| 2   | PG        | `saveMarks` repetido 50 veces concurrente con el mismo `requestId`                                    | 1 sola aplicación; 49 `replayed:true`; N eventos = N renglones cambiados; revisión +1    |
| 3   | PG        | Mismo `requestId`, otro contenido                                                                     | `409 IDEMPOTENCY_MISMATCH`; sin cambios                                                  |
| 4   | F         | Respuesta perdida (cortar tras COMMIT) y reenvío con `jti` nuevo                                      | `replayed:true`; sin duplicados; borrador intacto                                        |
| 5   | F         | Caída antes de guardar y reenvío                                                                      | Se aplica una vez                                                                        |
| 6   | PG        | Reenvío del mismo `jti`                                                                               | `401 INVALID_PROOF`; no cambia asistencia; (confirma que DPoP ≠ idempotencia)            |
| 7   | PG        | Dos prefectas (cobertura) guardan a la vez                                                            | Una `200`, otra `409 REVISION_CONFLICT`; ningún renglón sobrescrito sin aviso            |
| 8   | E2E       | Dos dispositivos de la misma prefecta, marcas distintas                                               | Se serializa; las diferencias se muestran; nada se pierde                                |
| 9   | PG        | Guardar vs. finalizar simultáneos                                                                     | Un resultado coherente: o finaliza con esas marcas o el guardado recibe `DAY_FINALIZED`  |
| 10  | PG        | Finalizar dos veces / por otra persona                                                                | `alreadyFinalized:true`; un solo evento `day_finalized`                                  |
| 11  | PG+U      | Revocar la asignación entre captura y envío                                                           | `404`; la operación queda `NEEDS_REVIEW`; el borrador sigue                              |
| 12  | PG+E2E    | Revocar el dispositivo                                                                                | `401 DEVICE_REVOKED`; sin reintentos; cola y borradores conservados                      |
| 13  | PG        | Cambio de ciclo / grupo inactivo                                                                      | `409 GROUP_INACTIVE`/`OUT_OF_YEAR`; sin cambios                                          |
| 14  | PG+U      | Medianoche: envío al día siguiente                                                                    | `NEEDS_REVIEW` (`DATE_NOT_TODAY`/`DAY_NOT_CURRENT`); una repetición ya aplicada sí `200` |
| 15  | U         | Reloj del teléfono adelantado/atrasado/reinicio                                                       | Fecha no confirmada; no se envía; `CLOCK_SUSPECT`; nunca se crea lista de otro día       |
| 16  | PG        | `open` con `attendanceDate` ≠ hoy                                                                     | `400 DATE_NOT_TODAY`; no se crea lista                                                   |
| 17  | PG+U      | Alumno ajeno al padrón congelado / transferido / baja                                                 | `400 STUDENT_NOT_IN_LIST`; operación derivada sin ese alumno; nada aplicado parcialmente |
| 18  | U         | Huella de ids vs. cambio de nombre                                                                    | La corrección de nombre **no** marca padrón cambiado; el cambio de ids sí                |
| 19  | I         | Sellado atómico (marcas ↔ operación) con fallo a mitad                                                | Todo o nada; borrador completo                                                           |
| 20  | I         | Matar el proceso en `SENDING`                                                                         | Al reabrir: `RETRYABLE_ERROR`; reenvío con el mismo `opId`; sin duplicados               |
| 21  | I         | Migración Room 2→3 con borradores                                                                     | Datos intactos; esquema válido; sin pérdida                                              |
| 22  | I+U       | Cola nunca contiene datos de otro perfil                                                              | Constraints y consultas por `profileId`; cambiar de cuenta no mezcla                     |
| 23  | U         | «Quitar marca» tras ACK                                                                               | Deshabilitado; si ocurre, `UNMARK_AFTER_ACK` y no se envía                               |
| 24  | U         | Tabla de reintentos (§13)                                                                             | 401/403/404/409/400 no reintentan solas; 429/503/timeouts sí, con jitter                 |
| 25  | E2E       | Sandbox: capturar offline, reconectar, enviar                                                         | `ACKNOWLEDGED`; en servidor 1 lista, 1 evento por cambio; en Android datos conservados   |
| 26  | E2E       | Mensajes de interfaz                                                                                  | Nunca «enviada» antes del ACK; mensajes de §12                                           |
| 27  | PG        | Privilegios: `eta15_api` sin `DELETE/TRUNCATE`; canal móvil con interruptor apagado                   | Sin permiso `attendance:*` en el token con el interruptor apagado; `403`                 |
| 28  | Seguridad | Guion adversarial: `userId`/rol/alcance en el cuerpo, `Origin`, cookie web, token de otro dispositivo | Rechazo sin efectos ni fugas                                                             |

Sin duplicados y sin pérdida de borradores son **invariantes transversales**: toda prueba de la lista las comprueba al final.

## 16. Decisiones pendientes

### A. Técnicas (pueden decidirse sin autoridad escolar; siguen siendo **provisionales**)

| #   | Decisión                                                                             | Propuesta                                             |
| --- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| A-1 | Conservar `requestId` (no `Idempotency-Key`)                                         | Conservar; revisar si el borrador se estandariza      |
| A-2 | Granularidad de operación: un guardado por grupo, sellado por delta                  | Sí (§6.3)                                             |
| A-3 | Reenvío automático tras `REVISION_CONFLICT` solo sin diferencias                     | Sí (§7.2)                                             |
| A-4 | Fecha derivada de «última fecha del servidor + tiempo monotónico»                    | Sí (§9)                                               |
| A-5 | ¿Abrir sesión móvil sin presencia de la persona (clave del dispositivo) para enviar? | Primera etapa: solo con la app en primer plano        |
| A-6 | Huella de padrón por ids; `rosterDigest` del servidor                                | Sí (§10, B5)                                          |
| A-7 | Valores de backoff e intentos máximos                                                | Los de §13, a medir                                   |
| A-8 | ¿Registrar `device_id` en `attendance_events` (migración) o solo en auditoría?       | Solo auditoría primero (B3); B7 si la escuela lo pide |
| A-9 | Libro de operaciones para idempotencia de `finalize` y guardados sin cambios         | Posponer; no hace falta para la primera etapa         |

### B. Reglas institucionales (**requieren validación**; no se escoge ninguna)

| #    | Decisión                                                                  | Alternativas seguras (ninguna está aprobada)                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-1  | **Vigencia offline real** y si lo ya capturado puede enviarse tras vencer | (a) la vigencia bloquea solo lectura/captura y no el envío; (b) bloquea también el envío hasta reautenticar con presencia; (c) vigencia por turno/día                                                                              |
| B-2  | **Capturas que llegan al día siguiente**                                  | (a) no se aceptan: quedan como evidencia local y Dirección decide fuera del sistema; (b) ventana de captura tardía supervisada, con marca explícita y permiso especial; (c) importación por Dirección con revisión de la evidencia |
| B-3  | **Prefecta que perdió el grupo** y qué pasa con sus capturas              | (a) descarte con acta; (b) revisión por Dirección; (c) aceptación supervisada con el rastro de la asignación vigente al momento de captura                                                                                         |
| B-4  | **Resolución de conflictos de contenido** y doble presencia por traslado  | (a) siempre la persona elige con ambos valores a la vista; (b) Dirección arbitra los casos que lo ameriten; (c) prefectura titular del grupo prevalece (requiere definir «titular»)                                                |
| B-5  | **Política de conservación local** tras ACK y finalización                | (a) hasta N días tras finalizar; (b) hasta cerrar sesión/perfil; (c) solo lo no confirmado                                                                                                                                         |
| B-6  | **Correcciones** de listas finalizadas (`attendance:correct`)             | (a) solo Dirección con motivo y bitácora; (b) correcciones solicitadas por prefectura y aprobadas por Dirección; (c) sin correcciones en el sistema                                                                                |
| B-7  | **Pérdida y robo** de dispositivos                                        | (a) reporte inmediato + revocación por Dirección; (b) caducidad corta del paquete + borrado al reconectar; (c) bloqueo de pantalla obligatorio (sin garantizar borrado remoto)                                                     |
| B-8  | **Retención de IP** y de auditoría móvil                                  | (a) IP gruesa y plazo corto; (b) sin IP; (c) plazo ligado a la política escolar                                                                                                                                                    |
| B-9  | **MFA** para datos reales                                                 | Requisito previo a datos reales; método y excepciones por definir                                                                                                                                                                  |
| B-10 | **ADR 0005** (autenticación móvil)                                        | Revisar y aceptar, modificar o rechazar antes de cualquier uso real                                                                                                                                                                |

Ninguna alternativa se marca como oficial ni se atribuye a la institución.

## 17. Plan de implementación (cada fase con su revisión; ninguna se ejecuta ahora)

| Fase | Contenido                                                                                                      | Compuerta                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 0    | Revisar este documento; redactar el ADR 0006 (protocolo) y decidir A-1…A-9; abrir las decisiones B             | Revisión de arquitectura y de seguridad                                                   |
| 1    | Backend: B1, B4, B5 y rutas móviles **de lectura** (`today`, `days`, `days/:id`) detrás de interruptor apagado | Pruebas HTTP, PGlite y clúster desechable; sin migraciones. **HECHA en el sandbox (§18)** |
| 2    | Backend: rutas móviles `open` y `marks` + B2/B3 y guion adversarial                                            | Revisión de seguridad; `test:pg-temp`; sin cambiar `eta15_dev`                            |
| 3    | Android: Room v3 (outbox, sellado, huella, regla de «quitar marca») **sin red**                                | Pruebas JVM/instrumentadas; migración 2→3                                                 |
| 4    | Android: emisor en primer plano (debug/sandbox) con reintentos e idempotencia; conflictos y pantallas          | E2E en emulador con inyección de fallos; sin `INTERNET` en release                        |
| 5    | `finalize` móvil y su interfaz humana; `rosterDigest`                                                          | Pruebas de carrera guardar/finalizar                                                      |
| 6    | WorkManager y envío en segundo plano                                                                           | Decisiones B-1 y A-5 cerradas                                                             |
| 7    | Decisiones institucionales (B-2, B-3, B-6…) → captura tardía/correcciones                                      | **Solo con validación de la escuela**                                                     |

Antes de cualquier uso real: B-9 (MFA), B-10 (ADR 0005), revisión de seguridad completa y aprobación institucional. Aplicar migraciones o privilegios a `eta15_dev` sigue exigiendo autorización explícita y el flujo de `CLAUDE.md` (respaldo, preflight, `pnpm db:apply-privileges`).

## 18. Fase 1: lecturas móviles de asistencia (IMPLEMENTADO solo en el sandbox)

Rama `feat/mobile-attendance-read` (apilada sobre el PR #4). **Implementado**: lecturas protegidas por el canal móvil, **verificadas con pruebas** (§18.6). **No implementado**: `POST` de asistencia, sincronización, outbox Room v3, finalización móvil, WorkManager y correcciones históricas. **No aprobado**: políticas offline, capturas tardías, conservación local real, ADR 0005 y ADR 0006.

### 18.1 Rutas (todas `GET`, `Cache-Control: no-store`, guardas móviles: `channelGuard` + `accessGuard`)

| Ruta                                                                      | Servicio reutilizado | Devuelve (contrato: `packages/shared-contracts/src/mobile-attendance.ts`)                                                           |
| ------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /mobile/school/attendance/today`                                     | `service.today`      | `schoolToday`, `isSchoolDay`, `serverTime`, y por cada grupo asignado **hoy**: `groupId`, `schoolYearId` y la lista de hoy o `null` |
| `GET /mobile/school/attendance/days?groupId&from&to&status&page&pageSize` | `service.list`       | Resumen de listas (`id`, `groupId`, `schoolYearId`, `attendanceDate`, `status`, `revision`, `counts`, `finalizedAt`), paginado      |
| `GET /mobile/school/attendance/days/:id`                                  | `service.get`        | `schoolToday`, `serverTime`, `day` (el resumen), `rosterDigest`, `records[]` (`studentId`, `status`, `markedAt`) y `discrepancies`  |

Se reutiliza el **mismo servicio** del portal (`createAttendanceService`, una sola instancia en `auth.module.ts`): ninguna regla de alcance, fecha o revisión se duplicó; `attendance.mobile.ts` solo registra, pasa el contexto del dispositivo y **proyecta**. No hay `events`, ni `open`, ni `marks`, ni `finalize`, ni ruta con otro método.

**No se devuelve**: nombres de alumnos (el id es el mismo de `/mobile/school/groups/:id/roster`, que Android ya descargó), quién abrió o finalizó, `createdAt`, `editable`/`canCapture` (el canal no escribe), datos del grupo (grado, código, turno, nombre del ciclo) ni nada de otros grupos.

`rosterDigest` (v1): `v1:` + SHA-256 hexadecimal de los `studentId` en minúscula, ordenados ascendentemente como cadenas y unidos con salto de línea (sin salto final). Representa **solo el conjunto de alumnos del padrón congelado de esa lista**: no cambia al marcar, ni al corregir un nombre, ni incluye estados. No es una versión del padrón actual: para eso están `discrepancies` (conteos de altas y bajas posteriores). La huella del padrón **descargado** en Android sigue siendo local y distinta (§10).

### 18.2 Activación controlada

- Interruptor **explícito** `mobile.attendanceRead` (opción de `buildApp`, **no** una variable de entorno ni parte de `mobile.config`); apagado por omisión. En el sandbox: `pnpm dev:sandbox -- --catalog-write --students-write --prefect-write --attendance-write --seed-attendance --mobile-auth --mobile-attendance-read`.
- Apagado, las rutas **no existen** (404) y el token no lleva ningún permiso de asistencia. Encendido, el token incluye **solo** `attendance:read` con alcance `assigned_groups` (nunca `all`, nunca `attendance:capture`).
- Con `NODE_ENV=production` el canal móvil completo **no se monta** (error al construir la aplicación) y la lectura de asistencia lo repite: ninguna variable aislada lo reactiva. Sin cambios de firewall, de credenciales ni del APK de release (sin `INTERNET`).

### 18.3 Autorización

Cada lectura vuelve a comprobar (por petición, en el servidor): prueba DPoP y `jti` no repetido; sesión móvil vigente y ligada a la clave; dispositivo activo; cuenta y rol vigentes (`mobile_user_eligible`); permiso `attendance:read` y su alcance leídos de la base; asignación de prefectura **vigente hoy** al grupo, grupo activo y ciclo vigente (`resolveAccess`). **Sin cambios de RBAC**: `attendance:read` ya existe para `prefectura` (`assigned_groups`) desde la migración 0010; no se creó ningún permiso, migración ni `GRANT`. Fuera de alcance e inexistente son **indistinguibles (404)**; un filtro `groupId` ajeno devuelve una lista vacía, no 403.

### 18.4 Fecha y revisión

«Hoy» sale de la base (`America/Mazatlan`); el cliente no puede cambiarlo (`today` y el detalle rechazan cualquier consulta con parámetros, y las cabeceras de fecha se ignoran). `serverTime` es el reloj del servidor de aplicaciones (informativo). `revision` es la de la lista: la que se enviaría como `expectedRevision` en la futura escritura. Distinguir: **fecha escolar** (`schoolToday`), **momento de la respuesta** (`serverTime`), **fecha de la lista** (`attendanceDate`), **padrón** (`rosterDigest`) y **revisión**; la fecha de un borrador de Android nunca es la efectiva. Las listas históricas se leen con el mismo alcance que ya aplicaba el servicio (grupos asignados hoy).

### 18.5 Lecturas consistentes (hallazgo nuevo)

El detalle de una lista se arma con varias consultas. En el nivel por omisión de PostgreSQL (READ COMMITTED), un guardado confirmado **entre** ellas producía respuestas con conteos de una revisión y renglones de otra. Se comprobó con un **control negativo**: con la foto desactivada la prueba de concurrencia real falló (renglones `[3, 0, 17]` frente a conteos `[2, 0, 18]`). Las lecturas móviles ejecutan ahora `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` como primera sentencia (opción `snapshot` de `today`, `list` y `get`; sin reintentos: solo lecturas y auditoría). **Estado actualizado en la fase 2**: el portal web usaba la misma función compartida y tenía la misma carrera; se reprodujo de forma determinista (§19.2) y se corrigió con el mismo cambio mínimo (la foto es ahora el comportamiento por omisión de las tres lecturas del servicio). En la fase 1 se había documentado como pendiente de un arreglo separado.

### 18.6 Pruebas ejecutadas (ficticias; nada en `eta15_dev`)

Fecha de ejecución: 2026-10-28. Datos, cuentas y dispositivos ficticios; PGlite y un PostgreSQL 18 **desechable** con `eta15_api` no propietaria y las propuestas de privilegios 0002 a 0006 aplicadas **solo en ese clúster**.

| Prueba                                                                                                   | Resultado                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lecturas móviles de asistencia, PGlite (`mobile-attendance-http.test.ts`)                                | 35 pasan, 3 se omiten (las de concurrencia real)                                                                                                                                                |
| Lecturas móviles de asistencia, PostgreSQL 18 desechable (`pgtemp/mobile-attendance.pg.test.ts`)         | 38 pasan (incluye 3 de concurrencia con conexiones reales)                                                                                                                                      |
| Registros HTTP sin valores de consulta (`log-redaction.test.ts`)                                         | 3 pasan                                                                                                                                                                                         |
| `pnpm test:pg-temp` completo                                                                             | 20 archivos, 566 pruebas, 0 fallos                                                                                                                                                              |
| `pnpm test` (API y portal)                                                                               | API 963 pasan (3 omitidas por diseño), portal 162 (una corrida intermedia falló por un tiempo de espera de 5 s en una prueba de activación del portal, ajena a este cambio; la repetición pasó) |
| `pnpm test:integration`                                                                                  | 41 pasan                                                                                                                                                                                        |
| `typecheck`, `lint`, `build`, `format:check`, `db:check`, `db:whoami`                                    | correctos                                                                                                                                                                                       |
| API compilada (`dist/server.js`): `/health` y `/ready` 200, sin rutas `/mobile/*`, `POST` sin Origin 403 | correcto (comprobación manual; el servidor se detuvo)                                                                                                                                           |

Cubren: sesión válida/ausente, DPoP ausente, firma o `ath` ajeno, repetición de `jti`, token vencido, dispositivo revocado, cuenta desactivada, rol revocado; prefecta A y B, grupo ajeno (404 idéntico al inexistente), sin asignación, grupo inactivo, ciclo no autorizado, asignación revocada; lista inexistente, borrador, finalizada, revisión, padrón y discrepancias; lunes a domingo, medianoche y cliente con fecha falsa; interruptor apagado, `NODE_ENV=production` y `mobile.config` que intenta encenderlo; cookie web rechazada en móvil, DPoP rechazado en el portal, CSRF y Origin del portal intactos, ausencia de métodos de escritura, `Cache-Control: no-store`, token en URL y registros sin secretos; auditoría con canal, dispositivo e IP gruesa; ausencia de datos sobrantes (sin nombres ni autores); lecturas simultáneas a guardados y a una finalización, y sin transacciones abiertas. **Android no se ejecutó** (no cambió).

Limitaciones: es un sandbox; un solo servidor; el control negativo de la foto consistente se hizo una vez de forma manual (con la foto desactivada la prueba falló) y no es una prueba permanente; `serverTime` usa el reloj del servidor de aplicaciones; no se probó contra un teléfono ni con carga real.

### 18.7 Hallazgos del diseño, verificados en el código y caracterizados con pruebas de comportamiento actual

Las pruebas están en `apps/api/test/helpers/mobile-attendance-suite.ts` (bloque «hallazgos del protocolo»). En la fase 1 **no cambiaron contratos ni implementaron correcciones**. **Actualización de la fase 2**: el hallazgo 1 **se corrigió** (§19.3) y su prueba pasó a verificar la corrección; los hallazgos 2, 3 y 4 siguen **sin cambios** (la columna «Comportamiento actual» de la fila 1 describe el estado anterior a la corrección).

| #   | Hallazgo                                                   | Ruta y función                                                                                                                                     | Comportamiento actual (probado)                                                                                                                             | Consecuencia                                                                                                             | Alternativas                                                                                                                                                                     | Cambio futuro recomendado                                                                                                |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Un guardado sin cambios no registra su `requestId`         | `POST /school/attendance/days/:id/marks` → `saveMarks`: con `changes.length === 0` devuelve `changed:0, replayed:false` antes de insertar eventos  | No deja evento; el mismo `requestId` puede reutilizarse luego con **otro** contenido sin `IDEMPOTENCY_MISMATCH` (con uno que sí dejó evento, sí se rechaza) | La garantía «mismo id, otro contenido → rechazo» no cubre los no-op. Riesgo bajo si el cliente nunca reutiliza un `opId` | (a) Tolerarlo (operaciones inmutables); (b) libro de operaciones `attendance_operations` (migración + privilegios); (c) evento `save_noop` (relaja el CHECK de forma de eventos) | Libro de operaciones solo si la escuela exige trazabilidad por operación (A-9); mientras, el cliente no reutiliza `opId` |
| 2   | Una marca guardada no se puede quitar                      | `saveMarksBody` (solo `present`/`absent`); trigger `att_records_guard_update` (`att_records_no_unmark`)                                            | La API responde 400 a `pending`, `null` y vacío; un `UPDATE … SET status = NULL` del propietario falla; sí se puede cambiar entre `present` y `absent`      | El «Quitar marca» de Android no puede propagarse tras confirmarse                                                        | (a) Deshabilitarlo en Android tras el ACK (propuesto, §6.4); (b) permitir «des-marcar» en el servidor (cambia una regla del modelo)                                              | Regla de interfaz y de cola en Android (fase 3); cualquier cambio del servidor requiere decisión institucional           |
| 3   | La finalización no distingue quién finalizó                | `POST …/finalize` → `finalize`: con la lista ya finalizada devuelve `alreadyFinalized:true` antes de comparar autor; `buildDetail(…, admin=false)` | La segunda prefecta recibe 200 `alreadyFinalized:true`; la respuesta (web y móvil) no incluye `finalizedBy`/`createdBy`                                     | El cliente no sabe si finalizó «él» u otra persona; podría creer que su captura quedó                                    | (a) Comparar `records[]` con lo confirmado (propuesto, §7.3, sin cambios de API); (b) `finalizedByMe` booleano (B6); (c) `requestId` en `finalize` (migración)                   | B6 (booleano, sin migración) si hace falta; no exponer identidades de otras prefectas                                    |
| 4   | Un borrador de ayer no tiene vía ordinaria de cierre/envío | `saveMarks`/`finalize`: `day.attendance_date !== today` → `409 DAY_NOT_CURRENT`; `open` con `attendanceDate` ≠ hoy → `400 DATE_NOT_TODAY`          | Tras la medianoche no se guarda ni se finaliza la lista de ayer; reabrir «hoy» crea **otra** lista; el móvil y el portal ven la de ayer en borrador         | Capturas offline de un día que ya pasó no pueden enviarse por el flujo ordinario y la lista de ayer queda sin finalizar  | Las de B-2 (§16): no aceptar y conservar como evidencia; ventana de captura tardía supervisada; importación por Dirección                                                        | Ninguno hasta que la escuela decida (B-2, B-6). **No se inventó una política de corrección histórica**                   |

## 19. Fase 2: escritura móvil de asistencia (IMPLEMENTADO solo en el sandbox)

Rama `feat/mobile-attendance-write-sandbox` (apilada sobre el PR #5). **Implementado**: en el backend de sandbox, abrir la lista del día y guardar marcas por el canal móvil, con idempotencia y detección de conflictos **verificadas con pruebas** (§19.7). **No implementado**: cliente Android de envío, outbox Room v3, WorkManager, finalización móvil, capturas históricas, correcciones de listas finalizadas y sincronización automática. **No aprobado**: políticas offline, capturas tardías, conservación local real, ADR 0005 y ADR 0006. **No hay sincronización offline completa**: el backend ya puede recibir asistencia de forma segura, pero nada la envía todavía.

### 19.1 Contratos finales (solo estas dos escrituras; mismos servicios que el portal)

| Ruta                                            | Cuerpo (Zod estricto)                                                                                             | Éxito                                                                       | Errores principales                                                                                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /mobile/school/attendance/days`           | `{ groupId, attendanceDate }` (**la fecha es obligatoria** en el canal móvil)                                     | `201 {day, created:true}` si la creó; `200 {day, created:false}` si existía | `400 DATE_NOT_TODAY`, `404` (grupo ajeno, inexistente, inactivo o de otro ciclo), `409 NOT_SCHOOL_DAY`, `GROUP_INACTIVE`, `OUT_OF_YEAR`, `EMPTY_ROSTER`, `ROSTER_CHANGED`, `CONCURRENT` |
| `POST /mobile/school/attendance/days/:id/marks` | `{ expectedRevision, requestId, marks:[{studentId, status}] }` (el mismo cuerpo del portal; ≤ 200 marcas, 32 KiB) | `200 {day, changed, replayed}`                                              | `400 STUDENT_NOT_IN_LIST`, `404`, `409 REVISION_CONFLICT`, `IDEMPOTENCY_MISMATCH`, `DAY_FINALIZED`, `DAY_NOT_CURRENT`, `GROUP_INACTIVE`, `CONCURRENT`; `503 DATABASE_UNAVAILABLE`       |

`day` es la proyección móvil de la §18.1 (sin nombres ni autores). Comunes a las dos: `Authorization: DPoP` + prueba DPoP nueva en cada petición; sin `Origin`, cookies ni CSRF; `Cache-Control: no-store`; errores `{ error: { code, message, requestId } }` donde `requestId` es el de la **petición HTTP del servidor**, no la clave de idempotencia. Códigos 401/403/429/503 del canal móvil como en §2.2. **Un cliente distingue un reintento de un conflicto definitivo**: 5xx/429 y la falta de respuesta se reintentan con el **mismo** `requestId`; 400/404 y los 409 de `IDEMPOTENCY_MISMATCH`, `DAY_FINALIZED`, `DAY_NOT_CURRENT` y `STUDENT_NOT_IN_LIST` no se reintentan sin revisar; `REVISION_CONFLICT` se resuelve consultando la lista (§7.2). **No existen** finalizar, borrar, actualizar ni historial por este canal.

### 19.2 Carrera de lectura del portal web: reproducida y corregida

`apps/api/test/pgtemp/attendance-read-consistency.pg.test.ts`, contra PostgreSQL 18 desechable con conexiones reales: el almacén se envuelve para que, justo **antes** de la consulta de renglones de `GET /school/attendance/days/:id`, otra prefecta guarde y confirme por HTTP. **Antes de la corrección** la respuesta mezclaba la cabecera de la revisión 1 (`present = 0`) con renglones de la 2 (`[0, 1, 1]` frente a `[1, 1, 2]`). **Causa real**: `service.get`, `today` y `list` (compartidos por el portal y el canal móvil) armaban la respuesta con varias consultas en READ COMMITTED. **Corrección mínima**: `beginSnapshot` (`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` como primera sentencia) pasó a ser el comportamiento por omisión de las tres lecturas (`{ snapshot: false }` solo existe para reproducir el defecto). Sin rutas nuevas ni cambios en autenticación, cookies, CSRF, Origin, MFA, RBAC o auditoría; la interfaz React no cambió. La misma prueba pasa tras la corrección y las suites del portal no cambiaron.

### 19.3 Idempotencia del guardado sin cambios (hallazgo 1 corregido)

**Problema**: un guardado sin cambios no dejaba ningún evento, así que su `requestId` no era durable y podía reutilizarse con otro contenido. **Solución sin migración** (el esquema ya lo permitía): el guardado sin cambios inserta **un evento de confirmación** `mark_changed` sobre el primer alumno de la operación (orden canónico por id) con `old_status = new_status` y `revision_after` igual a la revisión vigente; `revision` **no sube**, y el historial distingue una confirmación de un cambio real porque `old = new`. **Por qué no una migración**: los CHECK `att_events_type` y `att_events_shape` rechazan cualquier evento con `request_id` que no sea `mark_changed` con renglón y estado, pero un `mark_changed` con `old = new` los cumple; una tabla de recibos o un tipo `save_noop` (migración 0013, privilegios y `DROP CONSTRAINT`) no aportaba una garantía distinta y acoplaba `eta15_dev` a una migración pendiente (el servicio habría fallado allí). Garantías verificadas:

- **Identificador estable y contenido inmutable**: el `requestId` identifica la operación; su huella es la de `marksHash` (SHA-256 canónico de `studentId:status` ordenado; no incluye `expectedRevision`).
- **Recibo durable**: está en `attendance_events` (PostgreSQL), no en memoria; sobrevive al reinicio de la API (prueba 12) y a varias conexiones (pruebas 2, 7 y 13).
- **Mismo `requestId`, otro contenido → `409 IDEMPOTENCY_MISMATCH`**, también para los no-op (antes se aceptaba).
- **Recibo de quien lo envió**: el mismo `requestId` desde **otra cuenta** (p. ej. cobertura compartida) se rechaza con el mismo error, sin reconocerlo ni revelar la operación ajena. En otra lista (otro grupo) el mismo UUID es una operación distinta.
- **Una sola aplicación efectiva**: los reintentos responden `200 replayed:true, changed:0` sin eventos nuevos ni subida de revisión; el orden de las marcas no importa y una `expectedRevision` vieja no impide reconocer una operación ya aplicada (la identidad de la operación se comprueba **antes** que la revisión, la fecha y el estado, y **después** de revalidar con bloqueo la autorización: sin acceso vigente → `404`, sin revelar nada).
- **Auditoría**: `attendance.marks_saved` (con `requestId`), `attendance.marks_unchanged` y `attendance.marks_replayed` (los reintentos quedan trazados sin duplicar eventos de asistencia).

### 19.4 Activación, permisos y fecha

- **Interruptor**: opción `mobile.attendanceWrite` (no es variable de entorno ni parte de `mobile.config`), **apagada por omisión**; `--mobile-attendance-write` en `pnpm dev:sandbox`. **Exige `attendanceRead`** (error al construir la aplicación si falta), el canal móvil y el sandbox; con `NODE_ENV=production` la aplicación no se construye. Apagado: no se registra ninguna ruta `POST`, el token **no** lleva `attendance:capture` y la credencial emitida con la escritura encendida **pierde** ese permiso en una aplicación sin ella (los permisos se calculan por petición).
- **Permisos**: la escritura exige `attendance:capture` con alcance `assigned_groups` (nunca `all`) más sesión móvil, DPoP, dispositivo y cuenta activos, rol de prefectura vigente, asignación vigente, grupo activo y ciclo; ningún cuerpo admite `userId`, rol, alcance, fecha efectiva ni campos ajenos (400). **Sin migraciones, `GRANT` ni cambios de RBAC**: `attendance:capture` ya existe para `prefectura`; solo se añadió a la lista de permisos que un token móvil puede ejercer, bajo el interruptor.
- **Fecha**: solo el día escolar actual del servidor (`America/Mazatlan`), lunes a viernes, una lista por grupo y fecha. `attendanceDate` distinta de hoy → `400 DATE_NOT_TODAY` (sin crear nada); sábado y domingo → `409 NOT_SCHOOL_DAY`; una lista de ayer no se guarda → `409 DAY_NOT_CURRENT`; **ninguna captura de ayer se convierte en hoy**; la repetición de una operación ya aplicada sí se reconoce tras la medianoche (no es captura tardía). La captura atrasada sigue pendiente de decisión institucional (§16 B-2).
- **Padrón**: se valida por identificador de alumno contra el padrón **congelado** de la lista: un alumno de otro grupo o dado de alta después de la apertura → `400 STUDENT_NOT_IN_LIST` y **no se aplica nada** de esa petición; `discrepancies` y `rosterDigest` (§18.1) permiten detectar el cambio. No se añadió ningún campo: la pertenencia por identificador ya impide aceptar marcas incompatibles en silencio, y no se inventó una política de traslados. Las listas finalizadas no se modifican (`409 DAY_FINALIZED`).
- **Errores de la base**: una conexión cortada o apagada responde **`503 DATABASE_UNAVAILABLE`** (si se cortó **antes** de confirmar no se aplicó nada; si se cortó **durante** el `COMMIT` el resultado es desconocido: en ambos casos se reintenta con el mismo `requestId`, que lo resuelve sin duplicar); antes respondía 500. El almacén de PostgreSQL ahora atiende el evento `error` del cliente de la transacción (sin oyente, una conexión cortada a mitad de transacción podía tumbar el proceso).

### 19.5 Volumen de `attendance.day_viewed` (documentado, no eliminado)

Cada lectura de una lista audita `attendance.day_viewed`, y es una auditoría obligatoria: no se eliminó. Un teléfono que sondea genera mucho volumen. **Solución propuesta que conserva la trazabilidad** (sin implementar): que el cliente sincronice por eventos y no por sondeo; y, si hace falta, registrar la **primera** lectura de cada (cuenta, dispositivo, lista) por ventana de tiempo y **contar** las siguientes en el mismo registro (agregación con conteo, no descarte), siempre con `attendance.marks_saved`/`marks_replayed` y los eventos de asistencia como trazabilidad completa de las **escrituras**. Requiere decisión sobre retención de auditoría (§16 B-8).

### 19.6 Prueba de timeout de `activation.test.tsx` (investigada, no «pasó al repetir»)

**Diagnóstico**: cada prueba de la pantalla de activación tarda ~1.5 s aislada (límite de 5 s). Escribir dos contraseñas de 33 caracteres con `userEvent` simula 66 pulsaciones y, por omisión, cada una cede el hilo con un temporizador mientras la pantalla evalúa la política de contraseña. Con la máquina ocupada (PostgreSQL desechable y pruebas de la API en paralelo) el tiempo se triplicaba y rozaba el límite: **dependía de la carga de CPU, no de un defecto de la pantalla**. Se reprodujo (archivo de 12 s a 24 s con la API corriendo en paralelo). **Corrección**: `userEvent.setup({ delay: null })` en ese archivo (sin esperas entre teclas; sigue escribiendo tecla a tecla): ~0.2 s aislada y ≤ 1.4 s con carga. **No se subió ningún límite de tiempo.** Los demás archivos del portal usan la misma API estática y podrían tener el mismo riesgo; no fallaron y no se tocaron.

### 19.7 Pruebas ejecutadas (ficticias; nada en `eta15_dev`)

Fecha de ejecución: 2026-10-28. Datos, cuentas y dispositivos ficticios; PGlite y un PostgreSQL 18 **desechable** con `eta15_api` no propietaria y las propuestas de privilegios 0002 a 0006 aplicadas **solo en ese clúster**.

| Prueba                                                                                                   | Resultado                                                         |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Escritura móvil, PGlite (`mobile-attendance-write-http.test.ts`)                                         | 23 pasan                                                          |
| Escritura móvil, PostgreSQL 18 desechable (`pgtemp/mobile-attendance-write.pg.test.ts`)                  | 36 pasan (incluye los 15 casos de concurrencia real)              |
| Carrera de lectura web (`pgtemp/attendance-read-consistency.pg.test.ts`)                                 | falló antes de la corrección (`[0, 1, 1]` ≠ `[1, 1, 2]`); pasa    |
| Lecturas móviles (fase 1, con el hallazgo 1 actualizado)                                                 | 35 pasan y 3 se omiten (PGlite); 38 pasan (PostgreSQL desechable) |
| `pnpm test:pg-temp` completo                                                                             | 22 archivos, 603 pruebas, 0 fallos                                |
| `pnpm test` (API y portal)                                                                               | API 986 pasan (3 omitidas por diseño), portal 162, 0 fallos       |
| `pnpm test:integration`                                                                                  | 41 pasan                                                          |
| `typecheck`, `lint`, `build`, `format:check`, `db:check`, `db:whoami`                                    | correctos                                                         |
| API compilada (`dist/server.js`): `/health` y `/ready` 200, sin rutas `/mobile/*`, `POST` sin Origin 403 | correcto (comprobación manual; el servidor se detuvo)             |

Cubren, además de lo de la fase 1: interruptor apagado, encendido sin lectura, `mobile.config` y `NODE_ENV=production`; un token emitido con la escritura que pierde el permiso en una app sin ella; ausencia de finalizar, borrar, actualizar e historial; DPoP (sin credenciales, firma o `ath` ajenos, repetición de `jti` **independiente** de la idempotencia, token vencido), dispositivo revocado, cuenta desactivada y rol revocado; grupo ajeno, sin asignación, inactivo y de otro ciclo (404 idéntico al inexistente), asignación revocada (un reintento no la revive); cuerpos con `userId`, rol, alcance o fecha ajenos; fecha equivocada, sábado, domingo y medianoche; padrón por identificador (alumno de otro grupo o alta posterior); lista finalizada; auditoría con cuenta, grupo, fecha, revisión y `requestId`, sin tokens. Concurrencia real: apertura simultánea, la misma operación por 20 conexiones, el mismo `requestId` con contenidos distintos, dos prefectas con la misma revisión, respuesta perdida, guardado sin cambios en paralelo, operaciones en orden inverso, revocación contra guardado, finalización web contra guardado móvil, cambio de padrón durante la apertura, reinicio de la API, caída de PostgreSQL a mitad del guardado (503, nada aplicado) y rollback de una transacción. **Android no se ejecutó** (no cambió).

Limitaciones: es un sandbox; un solo servidor; el PostgreSQL desechable no reproduce carga real ni fallos de red reales (la caída se simula cortando la conexión del propio guardado); no hay cliente móvil real ni teléfono; el control negativo de la foto consistente de las lecturas móviles se hizo manualmente en la fase 1, y la carrera web quedó como prueba permanente.

## 20. Auditoría de seguridad de la escritura móvil (Prompt 42)

Revisión crítica del código de la fase 2 antes de conectar Android. Resultado: **cuatro defectos corregidos con pruebas, ningún bloqueo**; el resto de los controles se verificó sin cambios. Todo en el sandbox; sin migraciones ni cambios en `eta15_dev`.

| #   | Hallazgo                                                                                                                                         | Prueba que lo reproducía                            | Corrección                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | El recibo de un guardado sin cambios (`mark_changed` con `old = new`) aparecía como un cambio en `GET …/events` (el único consumidor de eventos) | el historial listaba 3 eventos con 2 cambios reales | `events()` excluye los recibos (lista y total); un cambio real nunca tiene `old = new`; pruebas de invariante y de paginado    |
| 2   | La grafía del identificador (mayúsculas) cambiaba la huella: la misma operación lógica se rechazaba o se confundía                               | mayúsculas → 400 en lugar de reconocer la operación | `studentId` se normaliza a minúsculas en el contrato; el orden y la grafía no eluden la identidad; duplicados por grafía → 400 |
| 3   | Un `requestId` reutilizado con otro contenido o desde otra cuenta se rechazaba **sin dejar rastro** (señal de abuso o de defecto del cliente)    | no había fila de auditoría                          | `attendance.idempotency_mismatch` (fallo) con cuenta, grupo, fecha, `requestId` y `sameActor`, sin contenido ni huella         |
| 4   | Las auditorías de guardado no llevaban la **fecha escolar** (solo `dayId`)                                                                       | revisión del detalle de `attendance.marks_*`        | `attendanceDate` en `marks_saved`, `marks_unchanged`, `marks_replayed` e `idempotency_mismatch`                                |

**Consumidores de `mark_changed`** (búsqueda en todo el repositorio): solo `events()` del servicio, los triggers de integridad (sin lógica de estado), `db:state` (conteo total) y las pruebas; el portal define `listAttendanceEvents` pero **ninguna pantalla lo usa**; **no existen** reportes, alertas ni estadísticas sobre eventos, y los conteos y resúmenes salen de `attendance_records` (verificado: un recibo no altera revisión, marcas, `marked_by`/`marked_at`, conteos ni `today`). Una reconstrucción futura del estado desde eventos debe **ignorar** las filas con `old = new` (aplicarlas sería inocuo, pero no son cambios).

**Verificado sin cambios**:

- Alcance del `requestId`: por lista y por cuenta; otro dispositivo de la misma cuenta lo reconoce; otro grupo o fecha es otra operación; la autorización se revalida con bloqueo antes de reconocerlo, también tras revocar, finalizar o pasar la medianoche; el recibo no revela nada ajeno.
- Interruptores: móvil apagado, lectura sin escritura, escritura sin lectura y producción. Credenciales: dispositivo, cuenta, rol, asignación, grupo y ciclo ajenos, token anterior tras renovar, permiso cambiado **después** de emitir el token, y cookies.
- El canal móvil expone **exactamente** dos escrituras de asistencia y ninguna otra (se comprueba sobre el árbol de rutas).
- Las lecturas fijan la foto REPEATABLE READ como **primera sentencia** y las escrituras no la usan (READ COMMITTED con bloqueo `FOR UPDATE` de la lista). Que la fila de la cuenta cambie entre la foto y la auditoría **no** produce fallos de serialización (clave foránea).
- Errores: conflictos (`40001`, `40P01`, `23505` → 409 `CONCURRENT`), integridad (`23514` → 400), fallos temporales (apagado y conexión cortada → 503) y fallos de programación (→ 500 genérico, sin detalles internos), con la transacción revertida y el reintento aplicándose una sola vez. **No** se convirtieron los errores de la base en 503 de forma indiscriminada.

**Riesgos residuales** (no bloquean el sandbox):

- Un cliente autorizado puede generar recibos y auditorías de reintento sin límite por lista (cada `requestId` nuevo o cada reintento escribe una fila). Es la misma clase de crecimiento que alternar una marca repetidamente, acotada solo por el límite de tasa (600 por minuto y ruta); antes de datos reales conviene un tope de eventos por lista.
- La caída de la conexión durante el `COMMIT` deja el resultado desconocido (lo resuelve el reintento idempotente, no un cambio de código).
- `attendance.day_viewed` sigue generando volumen (§19.5).
- Un `40P01` real no se reproduce (las escrituras bloquean en un orden fijo: lista y luego renglones por id); se probó por inyección.

**Pruebas de esta auditoría (2026-10-28, datos ficticios)**: escritura móvil 30 (PGlite) y 44 (PostgreSQL 18 desechable); suites de asistencia web y de lecturas móviles sin regresiones; `pnpm test:pg-temp` 22 archivos, **611 pruebas, 0 fallos**; `pnpm test` API 993 (3 omitidas por diseño) y portal 162; `test:integration` 41; `typecheck`, `lint`, `build`, `format:check`, `db:check` y `db:whoami` correctos. Android no cambió y no se ejecutó. Las pruebas están en `apps/api/test/helpers/mobile-attendance-write-suite.ts` (bloque «auditoría de seguridad»).

## 21. Fase 3: outbox local persistente en Android (IMPLEMENTADO solo en el sandbox; **Android no envía nada**)

Rama `feat/android-offline-outbox`, apilada sobre el PR #6 → #5 → #4 → #3 → #2 (todos Draft). Room v3, estados y pruebas: [android-prefectura.md](android-prefectura.md) (sección «Outbox local persistente»). Esta fase no cambia el backend, PostgreSQL, `eta15_dev` ni los ADR (0005 y 0006 siguen PROPUESTOS).

### 21.1 Mapa contra el diseño de las fases anteriores

| Concepto del diseño                  | En Android hoy                                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operación `open`                     | `sync_operations` con `kind=OPEN`, una por (perfil, grupo, fecha); sin payload ni `requestId` propio; puede quedar `READY` (solo depende de la fecha) pero nada la envía                        |
| Operación `saveMarks`                | `kind=SAVE_MARKS`; `requestId` UUID en minúscula; hash `marksHash` idéntico al del backend (SHA-256 de `studentId:status` ordenado y unido con `\|`); máximo 200 marcas; solo marcas explícitas |
| `sync_day_state`, `sync_acked_marks` | No se crearon: el estado confirmado se deriva de las operaciones `ACKNOWLEDGED` del grupo y la fecha (una sola fuente de verdad)                                                                |
| `dayId`, `expectedRevision`          | Columnas **fuera de la identidad sellada**, nulas hasta que el transporte las conozca                                                                                                           |
| Recibo                               | `ackRevision`, `ackedAt`, `ackChanged`, `ackReplayed`, `serverDayId`; solo se llenan en pruebas                                                                                                 |

### 21.2 Identidad sellada y contexto remoto

El `requestId`, el payload, el hash, la fecha escolar y su procedencia se sellan en una sola transacción y son **inmutables** (disparadores). Lo que depende del servidor (`serverDayId`, `expectedRevision`) se completa después sin alterar esa identidad: `resolveContext` solo llena esas columnas y mueve `WAITING_REMOTE_CONTEXT` → `READY` cuando la dependencia está `ACKNOWLEDGED`. Así un reintento reutiliza siempre el mismo `requestId` y el mismo contenido; si cambia la revisión esperada, el servidor responde `409` (se maneja en la fase de transporte) y la persona decide, **sin crear automáticamente** otra operación `READY` con una revisión obsoleta.

### 21.3 Reglas que ya se cumplen (probadas en Room real)

- Un cambio de marca y su intención se guardan en la misma transacción; sellar es todo o nada y un fallo no deja payload parcial ni reemplaza la operación anterior.
- Editar después de sellar conserva la operación sellada y registra otra intención; una operación que pudo llegar al servidor nunca se reemplaza, solo se encadena; no se borra ninguna operación histórica.
- Pendiente no es una orden de borrar: no viaja, y una marca confirmada por el servidor no puede volver a Pendiente.
- Fecha de ayer, fecha no confirmada por el servidor, padrón distinto, alumno inactivo, grupo o dispositivo revocado: nunca `READY`; marcas y payload no se tocan.
- `SENDING` tras un reinicio = resultado desconocido (`RETRYABLE_ERROR`, `RESULT_UNKNOWN_AFTER_RESTART`).

### 21.4 Lo que NO existe

Cliente HTTP de asistencia, `WorkManager`, reintentos, resolución de `409`, finalización móvil, capturas históricas y correcciones. El E2E contra el sandbox registró **0** peticiones `/attendance`; el release no declara `INTERNET`.

### 21.5 Contrato pendiente para la fase de transporte

1. Cliente `OPEN`: guardar `serverDayId` y `revision` del recibo (`beginSending` → `acknowledge` → `resolveContext` de las `SAVE_MARKS` dependientes).
2. Cliente `SAVE_MARKS` con `requestId` y `expectedRevision`; recibos `replayed` idempotentes; `409` → `CONFLICT`/`NEEDS_REVIEW`.
3. Programador de segundo plano con reintentos acotados y reglas de red; `AUTH_REQUIRED` al expirar la sesión móvil.
4. Decisiones institucionales pendientes (§16.B): capturas tardías, listas finalizadas y conservación local. Ninguna se asume.

## Qué cubre y qué no este diseño

- **Cubre**: contratos reales verificados, operaciones, identidades, outbox, concurrencia, autorización, fecha, padrón histórico, conflictos, reintentos, pruebas y decisiones.
- **No cubre ni afirma**: que el protocolo esté implementado, probado o aprobado; que Android envíe asistencia hoy (no lo hace: solo el backend de sandbox lo permite); datos reales; reglas escolares no decididas; MFA; atestación del dispositivo.
