# Asistencia diaria (una lista por grupo y fecha)

Estado: **implementada, validada en entornos aislados y con esquema y privilegios mínimos APLICADOS en `eta15_dev` el 2026-10-27** (migración **0010** y privilegios **0005**; 11 migraciones, 17 tablas, **0 datos**, sin cuentas ni alumnos). Las
reglas de la sección 1 las definió la escuela. Lo demás son **decisiones técnicas provisionales del MVP** (sección 2) o **decisiones futuras** (sección 3) y **no están ratificadas por la institución**. No hay Android, sincronización offline,
justificantes ni retardos de puerta en esta fase.

> Este documento reemplaza el diseño preliminar anterior (que solo contenía recomendaciones). La sección 4 explica en qué se conservó y en qué cambió.

## 1. Requisitos CONFIRMADOS por la escuela

1. **Una sola lista por grupo y por fecha escolar** (no por materia ni por clase).
2. Se puede tomar lista **a cualquier hora** del día escolar permitido.
3. **No se registran listas en sábado ni en domingo.**
4. La fecha escolar usa **`America/Mazatlan`** (UTC−7, sin horario de verano).
5. Tres prefectas atienden los grupos que **Dirección** les asigne; una prefecta puede tener varios grupos y **varias personas pueden tener acceso al mismo grupo**.
6. La asistencia **se conserva si un alumno cambia de grupo** (la lista de un día no cambia por un traslado posterior).
7. Los **justificantes** son de Trabajo social, en otro flujo; el **registro de entradas y retardos en la puerta** es otro módulo.
8. La app Android trabajará sin internet en una **fase posterior** (no se implementa ni se define su protocolo aquí).

## 2. Decisiones PROVISIONALES del MVP (técnicas, no ratificadas)

| #   | Regla provisional                                                                                                                                                              | Dónde se impone                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 1   | La captura ordinaria es **solo para el día escolar de hoy**, calculado **por el servidor** en `America/Mazatlan`                                                               | Servicio (`todayOf`: la base, no el cliente ni el reloj del proceso)                            |
| 2   | El cliente **no decide la fecha**: si envía `attendanceDate`, solo se **contrasta** con la del servidor (otra fecha ⇒ `400 DATE_NOT_TODAY`, sin crear nada)                    | Contrato Zod + servicio                                                                         |
| 3   | No se abren listas en sábado ni domingo                                                                                                                                        | CHECK `att_days_weekday` (base, exacto: `date` no tiene zona) + servicio (`409 NOT_SCHOOL_DAY`) |
| 4   | Sin horarios de clase: se puede abrir y capturar a cualquier hora del día escolar                                                                                              | (no hay validación horaria)                                                                     |
| 5   | **No hay calendario de días no lectivos** (festivos, suspensiones): no se inventó uno                                                                                          | —                                                                                               |
| 6   | No hay listas **futuras** ni **pasadas** por el flujo ordinario                                                                                                                | Base: `att_days_not_future`; servicio: solo la fecha de hoy                                     |
| 7   | Los estados de captura son **`present`** y **`absent`** (definitivos)                                                                                                          | CHECK `att_records_status`                                                                      |
| 8   | **Pendiente** = el alumno aún no está marcado en un borrador (`status` NULL). **No es un estado de asistencia** y no se puede finalizar una lista con pendientes               | Trigger `att_days_guard_update` (`att_days_no_pending`) + servicio                              |
| 9   | Una lista **finalizada** no se modifica por el flujo ordinario (ni el propietario puede cambiarla sin quitar el trigger)                                                       | Triggers `att_days_guard_update` / `att_records_guard_update` (`42501`)                         |
| 10  | Los justificantes **no sobrescriben** la asistencia tomada; los retardos de puerta están **totalmente separados**                                                              | No existen en este módulo                                                                       |
| 11  | La **corrección formal** de una lista finalizada (`attendance:correct`) está **bloqueada**: no hay endpoint ni operación                                                       | Sin ruta (la prueba verifica que no existe); permiso solo de Dirección, reservado               |
| 12  | Un grupo **sin alumnos inscritos hoy no abre lista** (`409 EMPTY_ROSTER`): una lista vacía no tiene sentido y sería finalizable sin alumnos                                    | Servicio; la base además impide finalizar sin renglones (`att_days_not_empty`)                  |
| 13  | Una lista abierta el día anterior **no se guarda ni se finaliza hoy** (`409 DAY_NOT_CURRENT`); queda como borrador consultable. Qué hacer con ella es una decisión futura (§3) | Servicio                                                                                        |
| 14  | La resolución de **conflictos offline** queda pendiente: aquí solo hay control optimista entre personas con conexión                                                           | —                                                                                               |

## 3. Decisiones FUTURAS (pendientes; no se tomaron)

1. **Calendario institucional no lectivo** (vacaciones, suspensiones, puentes): ¿bloquea abrir listas o solo avisa? Quién lo administra.
2. **Capturas de días anteriores** y su ventana (hoy: ninguna por el flujo ordinario; un borrador de ayer queda sin finalizar).
3. **Correcciones oficiales** de listas finalizadas: quién, cuándo, con qué motivo y cómo se anula. El esquema ya guarda historial inmutable; falta la política.
4. **Resolución de conflictos offline** (A/B/C del borrador anterior) y el protocolo de sincronización.
5. **Revocaciones estando sin conexión** y qué hacer con capturas hechas después de una revocación.
6. **Vigencia offline** de una concesión de captura.
7. **Justificantes de Trabajo social** y el permiso específico que reemplazará la lectura global retirada.
8. **Reportes acumulados** (porcentajes, periodos) y **alertas por faltas** (umbrales y destinatarios).
9. Alumnos que llegan al grupo **después de abierta la lista** el mismo día (hoy: el padrón queda congelado y se informa una discrepancia).
10. Estados adicionales (retardo, permiso, salida anticipada) y quién puede finalizar o reabrir; retención de la asistencia.
11. MFA para datos reales (sigue pospuesto solo en desarrollo local).

## 4. Qué se conservó y qué cambió respecto al diseño preliminar

| Tema           | Diseño preliminar                                             | Implementación (y por qué)                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unicidad       | `UNIQUE (group_id, date)` + `INSERT … ON CONFLICT DO NOTHING` | **Igual** (`att_days_group_date_key`), más CHECK de lunes a viernes.                                                                                                                                        |
| Renglones      | "No pre-crear" (solo los capturados)                          | **Cambió**: el padrón se **congela al abrir** (un renglón pendiente por alumno), porque el requisito del MVP es un conjunto estable y poder saber quién falta. Evita depender del padrón vivo al finalizar. |
| Cierre         | `closed_at/by` opcional                                       | **Cambió**: `status` `draft`/`finalized` + `finalized_by/at` + `revision`; finalizar exige cero pendientes (trigger).                                                                                       |
| Idempotencia   | `client_event_id` por captura                                 | **Cambió**: `request_id` por **guardado** + huella SHA-256 del contenido (mismo identificador con otro contenido ⇒ rechazo). Más simple y suficiente sin offline.                                           |
| Historial      | `attendance_record_events` con `source`                       | **Igual en espíritu**: `attendance_events` solo-agregar (apertura, cambio de renglón con estado previo y nuevo, finalización). Sin `source` (solo hay web).                                                 |
| Conflictos     | Opciones A/B/C (offline)                                      | **Pospuestas**; con conexión rige el control optimista por `revision` (409 y recarga).                                                                                                                      |
| Trabajo social | Brecha: `attendance:read` con alcance `all`                   | **Cerrada por migración 0010** (retiro de la asignación; conserva `justifications:*`).                                                                                                                      |
| Permisos       | `attendance:capture/read/correct`                             | **Igual** (nombres reales confirmados: `capture`, no `take`). No se crearon permisos nuevos.                                                                                                                |

## 5. Modelo (migración 0010)

### `attendance_days` (la lista)

`id` UUID v7 · `school_year_id` + `group_id` (FK compuesta al grupo del ciclo) · `attendance_date` · `status` (`draft`/`finalized`) · `revision` (≥ 1, +1 por guardado con cambios y por la finalización) ·
`created_by` · `finalized_by` / `finalized_at` · `created_at` / `updated_at`.

Restricciones: `UNIQUE (group_id, attendance_date)`; `CHECK isodow 1–5`; `CHECK` de consistencia de finalización. Triggers (todos `SECURITY INVOKER`, `search_path` fijo, sin `EXECUTE` para PUBLIC):

- **Alta** (`att_days_guard_insert`): grupo **activo** (bloqueado `FOR SHARE`), fecha dentro del ciclo (bloqueado), **no futura**, nace borrador con revisión 1.
- **Cambio** (`att_days_guard_update`): identidad inmutable; una finalizada es historia; en borrador la revisión solo avanza de uno en uno; **finalizar** exige renglones y **ninguno pendiente** y fija `finalized_at = now()`.
- **Fechas del ciclo** (`school_years_guard_attendance_dates`): un cambio de fechas no puede dejar listas fuera del ciclo (el catálogo responde 409).

### `attendance_records` (el padrón congelado)

`id` · `attendance_day_id` + `school_year_id` (FK compuesta a la lista) · `enrollment_id` + `school_year_id` (FK compuesta a la **matrícula del mismo ciclo**) · `group_assignment_id` (la **asignación de grupo histórica**
que justifica que el alumno esté en la lista) · `status` (NULL = pendiente) · `marked_by` / `marked_at`.

`UNIQUE (attendance_day_id, enrollment_id)`: un alumno una sola vez por lista. No se duplican datos personales: el nombre se obtiene por la matrícula al leer.

- **Alta** (`att_records_guard_insert`): solo **en la misma transacción que creó la lista** (`created_at = now()`) y mientras es borrador ⇒ **no hay altas posteriores**; el alumno debe estar activo y con **matrícula vigente ese día**; la asignación debe
  ser **de esa matrícula, de ese grupo y vigente ese día** (el grupo sale de la lista, no del cliente); matrícula y asignación quedan bloqueadas `FOR SHARE` (una baja o un traslado simultáneo espera o ya se vio). Nace pendiente.
- **Cambio** (`att_records_guard_update`): identidad inmutable; solo cambia el estado (pendiente → presente/ausente, o entre ambos; **nunca vuelve a pendiente**) y solo en borrador (bloquea la lista `FOR SHARE`); `marked_at` lo fija el trigger.

### `attendance_events` (historial, solo se agrega)

`id` · `attendance_day_id` · `record_id` (solo en cambios de renglón; FK compuesta que obliga a que sea de la **misma lista**) · `event_type` (`day_opened`, `mark_changed`, `day_finalized`) · `actor_id` · `request_id` +
`payload_hash` (idempotencia) · `old_status` / `new_status` · `revision_after` · `occurred_at`. Triggers que impiden `UPDATE`, `DELETE` y `TRUNCATE` **incluso al propietario**. Sin nombres ni credenciales. `UNIQUE` parciales: abrir y finalizar una sola vez
por lista; un renglón cambia una sola vez por solicitud.

**Por qué `attendance_events` y no solo `audit_events`**: la auditoría general registra _seguridad_ (apertura, guardados con conteos, finalización, conflictos, denegaciones; siempre con IDs y conteos). El historial por renglón (estado previo y nuevo, quién y cuándo,
con consulta por lista) es **dato del dominio** y necesita FK, unicidad e inmutabilidad propias. Ambos se escriben en la **misma transacción**; no se duplica contenido personal.

Sin `DELETE` físico ni `ON DELETE CASCADE` en ninguna tabla.

## 6. Padrón de la lista y cambios posteriores

La lista de un día = alumnos **activos** con **matrícula** y **asignación de grupo vigentes ese día en ese grupo** (periodos inclusivos). Como un alumno no puede estar en dos grupos el mismo día, la consulta es inequívoca. Al abrirla se bloquea el padrón y se
insertan todos los renglones en la misma transacción que la cabecera.

- **Alumno que entra al ciclo después**, **traslado**, **baja** (su último día cuenta), **alumno inactivo**, **dos ciclos** (la FK compuesta exige la matrícula del ciclo de la lista) y **cambio de grupo en otra fecha**: probados en PGlite, PostgreSQL desechable y HTTP.
- **Cambios después de abrir**: no alteran los renglones (ni de borradores ni de finalizadas). `discrepancies` del detalle informa `addedToRoster` (padrón actual que no está en la lista) y `removedFromRoster` (renglones que ya no corresponden); la interfaz lo avisa. Nada se actualiza
  retroactivamente. Cómo incorporar a un alumno que llega ese día es una decisión futura.
- Un traslado o baja **concurrente con la apertura** espera (`FOR SHARE`) y la lista se abre con el padrón ya actualizado (probado con conexiones reales).

## 7. Concurrencia, idempotencia y límites

| Situación                                   | Resolución                                                                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dos personas abren la misma lista a la vez  | `UNIQUE` + `ON CONFLICT DO NOTHING`; la segunda espera el `COMMIT` y recibe **la misma lista** (`created: false`). Nunca hay otra.                                                              |
| Dos guardados con la misma revisión         | La lista se bloquea `FOR UPDATE`; el primero gana, el segundo recibe `409 REVISION_CONFLICT` y **no se sobrescribe nada**; recarga y reintenta.                                                 |
| Reintento idéntico (la respuesta se perdió) | Mismo `requestId` ⇒ `replayed: true`, **sin historial ni revisión nuevos**, aunque la revisión haya avanzado o la lista ya esté finalizada.                                                     |
| Mismo `requestId` con otro contenido        | `409 IDEMPOTENCY_MISMATCH`.                                                                                                                                                                     |
| Guardar vs finalizar                        | Se serializan por el bloqueo de la lista: o gana el guardado (la finalización con revisión vieja recibe 409) o gana la finalización (el guardado recibe `DAY_FINALIZED`). Nunca una mezcla.     |
| Dos finalizaciones                          | Una escribe; la otra ve la lista finalizada y devuelve **el mismo resultado** (`alreadyFinalized: true`); un solo evento. A nivel de base, la segunda recibe `42501`.                           |
| Revocación de la asignación vs guardado     | El servicio bloquea la asignación y la cuenta `FOR SHARE` (`lockGroupAccess`): la revocación espera al guardado en curso, o ya se vio y el guardado recibe 404. Lo capturado antes se conserva. |
| Grupo desactivado durante la captura        | Con el grupo inactivo la prefecta pierde el acceso (404 indistinguible); si la desactivación llega entre la comprobación y el bloqueo, `409 GROUP_INACTIVE`.                                    |
| Sesión o rol revocado                       | 401 inmediato (las sesiones se revocan por trigger).                                                                                                                                            |

**Esto NO es un protocolo de sincronización offline.** `requestId` y `revision` resuelven reintentos y concurrencia **con conexión**. No hay órdenes por reloj del dispositivo, ni tokens de concesión, ni cuarentena de capturas; todo eso se diseñará con la fase Android.

## 8. Fechas y medianoche

- "Hoy" es `(now() AT TIME ZONE 'America/Mazatlan')::date` evaluado **en la base por cada operación**; la hora local de Mazatlán decide el día (a las 06:59:59Z sigue siendo el día anterior; a las 07:00:00Z cambia).
- Una captura que **empieza antes de la medianoche y termina después** no se acepta en silencio: guardar o finalizar una lista cuya fecha ya no es hoy responde `409 DAY_NOT_CURRENT`; la interfaz la muestra como solo lectura ("es de un día anterior"). Las marcas
  confirmadas **antes** de la medianoche se conservan (el borrador queda sin finalizar). Hoy no hay forma ordinaria de finalizarlo: decisión futura §3.2.
- La base garantiza fecha laborable, dentro del ciclo y no futura; **que sea exactamente hoy lo impone el servicio** (para no cerrar la puerta, sin migración, a futuras capturas de días anteriores autorizadas).
- Las pruebas usan un **reloj escolar simulado** (`schoolToday`, solo pruebas y sandbox): recorren lunes a domingo y la medianoche sin depender del día en que se ejecuten.

## 9. Autorización (RBAC)

Permisos reales (no se crearon nuevos): `attendance:capture` (solo `assigned_groups`), `attendance:read` (`all` o `assigned_groups`) y `attendance:correct` (`all`, **reservado y sin operación**).

| Rol            | Consulta                            | Captura (abrir, guardar, finalizar)      | Corrige   | Notas                                                                                       |
| -------------- | ----------------------------------- | ---------------------------------------- | --------- | ------------------------------------------------------------------------------------------- |
| Dirección      | **Todas** (`all`, supervisión)      | No (no tiene `attendance:capture`)       | Reservado | Ve quién abrió y finalizó y el actor de cada evento                                         |
| Prefectura     | Solo sus grupos (`assigned_groups`) | Solo sus grupos y **solo el día de hoy** | No        | No ve quién abrió/finalizó ni actores; no administra permisos                               |
| Trabajo social | **Ninguna** (retirada por 0010)     | No                                       | No        | Conserva `justifications:*`; recibirá un permiso específico cuando la institución lo defina |
| Control acceso | Ninguna                             | No                                       | No        |                                                                                             |
| Admin técnico  | Ninguna                             | No                                       | No        | Sin acceso escolar (dominio técnico)                                                        |

- **Brecha cerrada**: la semilla `0004` concedía `attendance:read` con alcance `all` a `trabajo_social`. La migración **0010** retira esa asignación (`-- eta15:allow-destructive`, **un único `DELETE`**, 1 evento de auditoría; 36 asignaciones de permisos al aplicarla). `justifications:read` y `justifications:manage` **no se tocaron**.
- El alcance se resuelve **en cada petición** con las asignaciones **de hoy** (`pgGroupAssignments`); haber tenido el grupo en el pasado no da acceso. En toda escritura se vuelve a comprobar **con bloqueo**.
- Fuera de alcance ≡ inexistente: **404 indistinguible** (listado, detalle, historial, guardado, finalización y apertura). Sin permiso: 403 + `authz.denied`.
- **Consultas por alumno** y **reportes**: no hay endpoints. Cuando existan deberán aplicar `attendance:read` con el alcance por grupo **en la consulta** y la misma proyección mínima; quedan como trabajo futuro.
- Ningún endpoint admite `userId`, `actorId`, hora ni estado inicial del cliente; el actor sale de la sesión. `role_permissions` no se escribe desde la API (privilegio solo `SELECT`).

## 10. API (`/school/attendance`, prefijo coherente con `/school/*`)

| Método y ruta                              | Permiso              | Descripción                                                                                         |
| ------------------------------------------ | -------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /today`                               | `attendance:read`    | Fecha escolar, si es día laborable y los grupos del día de quien consulta con el estado de su lista |
| `POST /days` `{groupId[, attendanceDate]}` | `attendance:capture` | **Obtener o crear** la lista de hoy (201 si la creó, 200 si ya existía)                             |
| `GET /days`                                | `attendance:read`    | Listas con filtros (grupo, rango, estado) y paginación                                              |
| `GET /days/:id`                            | `attendance:read`    | Detalle: renglones, conteos, `editable`, `discrepancies`                                            |
| `POST /days/:id/marks`                     | `attendance:capture` | Guardar el borrador `{expectedRevision, requestId, marks[]}` (≤ 200)                                |
| `POST /days/:id/finalize`                  | `attendance:capture` | Finalizar `{expectedRevision}`                                                                      |
| `GET /days/:id/events`                     | `attendance:read`    | Historial paginado (IDs y estados; el actor solo para Dirección)                                    |

Todas: sesión obligatoria (401), CSRF y Origin en mutaciones (403), Zod estricto (400), `Cache-Control: no-store`, límite de peticiones y auditoría con IDs. Errores de negocio: `NOT_SCHOOL_DAY`, `DATE_NOT_TODAY`, `EMPTY_ROSTER`, `GROUP_INACTIVE`, `REVISION_CONFLICT`,
`IDEMPOTENCY_MISMATCH`, `STUDENT_NOT_IN_LIST`, `PENDING_RECORDS`, `DAY_FINALIZED`, `DAY_NOT_CURRENT`; sin la migración o los privilegios: `503 ATTENDANCE_UNAVAILABLE` sin detalles SQL. **No existen** `DELETE`, ruta de corrección ni importación masiva.

## 11. Interfaz (`/asistencia`, `apps/web-admin`)

Pantalla de **prueba del flujo escolar antes de Android** (no la sustituye). Tinto institucional, accesible y responsive (probada a 375 px: sin desbordamiento horizontal y destinos táctiles de 44 px).
Muestra los grupos del día con su estado y avance; abre o continúa la lista; marca **Presente/Ausente** con grupos de opciones nombrados por alumno; muestra pendientes y conteos en una región `aria-live`; **Guardar borrador** (envía solo lo que cambió); **Finalizar**
(solo sin pendientes y sin cambios sin guardar, con diálogo de confirmación y resumen). Ante un conflicto (409) **no sobrescribe**: avisa, conserva las marcas locales, y "Recargar la lista" respeta lo que otra persona ya marcó distinto. Un fallo de red conserva las marcas y el
reintento reutiliza el **mismo** `requestId`. Listas finalizadas, de un día anterior o de cuentas de solo consulta se muestran **sin controles de edición**; los errores reciben el foco. No muestra controles que la cuenta no puede usar (el servidor vuelve a autorizar).

## 12. Privilegios (propuesta `0005-attendance-write`, SIN APLICAR)

8 `GRANT` por columna para `eta15_api`, con `proposal.sql` (línea 1 `\quit`), `apply.sql` (preflight + GRANT idénticos a la propuesta) y `verify.sql` (privilegios efectivos, falla por de más o de menos). Se aplicaría con
`pnpm db:apply-privileges 0005-attendance-write --sha256=<hash> [--execute]` (ensayo con `ROLLBACK` por defecto).

| Tabla                | SELECT                   | INSERT                                                                                                                 | UPDATE                           |
| -------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `attendance_days`    | todas salvo `updated_at` | `school_year_id, group_id, attendance_date, created_by`                                                                | `status, revision, finalized_by` |
| `attendance_records` | todas salvo `updated_at` | `attendance_day_id, school_year_id, enrollment_id, group_assignment_id`                                                | `status, marked_by`              |
| `attendance_events`  | todas                    | `attendance_day_id, record_id, event_type, actor_id, request_id, payload_hash, old_status, new_status, revision_after` | **ninguno**                      |

Nunca `DELETE`, `TRUNCATE`, `TRIGGER`, `REFERENCES`, `CREATE`, `GRANT OPTION`, `ALL`, escritura sobre `role_permissions`/Auth ni acceso a `extensions`. La hora (`finalized_at`, `marked_at`, `occurred_at`) la fijan triggers o `DEFAULT`; la API no la escribe. Los triggers de la 0010 son
`SECURITY INVOKER` y funcionan con estos privilegios más los ya aprobados (0002–0004); `FOR SHARE` requiere algún `UPDATE` de columna en la tabla bloqueada (el preflight lo comprueba).

**Dependencia**: sin 0005, aplicada 0010, cambiar las **fechas de un ciclo** falla con un mensaje controlado (el trigger de 0010 lee la asistencia) y la asistencia responde 503; las demás operaciones del catálogo siguen. El preflight de 0005 exige 0002, 0003, 0004 y 0010.

## 13. Pruebas (todo con datos ficticios; nada en `eta15_dev`)

Resumen de resultados en [estado-del-proyecto.md](estado-del-proyecto.md). Cobertura:

- **Migración (PGlite)**: estructura, unicidad, fines de semana, no futuras, ciclo, padrón (ingreso tardío, traslado, baja, inactivo, dos ciclos, cambio en otra fecha, padrón congelado), estados, finalización, historial solo-agregar, sin `DELETE`, RBAC incremental 0009 → 0010 (conteos 37 → 36 y 13 → 14 eventos).
- **HTTP (PGlite y clúster PostgreSQL 18 desechable con `eta15_api`)**: 401/403/404/409, CSRF y Origin, cuerpos estrictos, lunes a domingo con reloj simulado, medianoche, aperturas simultáneas, guardados simultáneos, finalizaciones simultáneas, guardar vs finalizar, reintentos idénticos y con otro contenido, revocación de asignación, de rol y de sesión, grupo desactivado, discrepancias, privacidad y logs sin secretos.
- **Privilegios y concurrencia real (varias conexiones)**: matriz exacta por columna, verificador, aplicación controlada de 0005 (preflight, ensayo, `COMMIT`, hash, atomicidad), carreras de apertura, guardado/finalización, grupo, ciclo, revocación y traslado.
- **Interfaz**: 25 pruebas de componentes (selección, captura, pendientes, guardado, finalización, errores, conflictos, sesión vencida, rutas protegidas, accesibilidad).
- **Navegador real** (`pnpm dev:sandbox -- --catalog-write --students-write --prefect-write --attendance-write --seed-attendance`): ver [Procedimiento de prueba](#14-procedimiento-de-prueba-en-navegador).

## 14. Procedimiento de prueba en navegador

Entorno aislado y desechable (no toca `eta15_dev`): `pnpm dev:sandbox -- --catalog-write --students-write --prefect-write --attendance-write --seed-attendance --show-credentials` (opcionalmente `--school-today=AAAA-MM-DD` fija el "hoy" escolar,
p. ej. un sábado) y `pnpm dev:web` en `http://127.0.0.1:5173`. Siembra un ciclo ficticio, dos grupos y dos prefectas (una con la cobertura compartida del grupo A). Ctrl+C lo destruye.

## 15. Aplicación en `eta15_dev` (EJECUTADA el 2026-10-27, con autorización explícita; procedimiento reutilizable)

1. Preflight de solo lectura (`pnpm db:state`) y respaldo `pg_dump -Fc` verificado fuera del repositorio.
2. `pnpm db:migrate` (solo 0010; confirmada en Git).
3. Ensayo con `ROLLBACK` y luego `--execute` de `pnpm db:apply-privileges 0005-attendance-write --sha256=<hash del .apply.sql>`.
4. Verificar como `eta15_api` dentro de `BEGIN … ROLLBACK` y con `pnpm db:state`. Las pruebas de integración de solo lectura (`attendance.integration.test.ts`) aceptan ambos estados (antes y después).

**Resultado de la aplicación (2026-10-27, commit `a9ffab0`)**

- Preflight: `pnpm db:whoami` y `pnpm db:state` coincidieron con lo esperado (10 migraciones, 14 tablas, 29 permisos, 37 asignaciones, 13 eventos, 0 datos; solo 0010 pendiente). Respaldo `pg_dump -Fc` en `C:\Users\asahe\Backups\ETA15\eta15_dev_pre-0010-0005_20261027-135633.dump` (fuera del repositorio; `pg_restore --list` correcto, 14 tablas) con resumen no sensible.
- `pnpm db:migrate` (solo 0010): 11 migraciones, 17 tablas, 29 permisos, **36** asignaciones, **14** eventos de auditoría, 0 filas en las tablas de asistencia; `trabajo_social` conserva solo `justifications:read|manage`. Las funciones nuevas tienen `search_path` fijo y ninguna es ejecutable por `PUBLIC`.
- `pnpm db:apply-privileges 0005-attendance-write --sha256=…`: ensayo con `ROLLBACK` y luego `--execute` (8 `GRANT`, verificador en la misma transacción).
- Comprobación como `eta15_api` (dentro de `BEGIN … ROLLBACK`, sin datos): `SELECT`/`UPDATE` aprobados funcionan; columnas no aprobadas, `DELETE`, `TRUNCATE`, `UPDATE` de `attendance_events`, `CREATE`, `SET ROLE eta15_app` y cualquier escritura de `role_permissions` fallan con 42501.
- Los flujos completos con datos ficticios siguen probándose solo en clústeres desechables y en `pnpm dev:sandbox`.

**Procedimiento de respaldo**: `pg_dump -Fc` con `eta15_app` hacia `Backups\ETA15` con nombre nuevo (nunca se sobrescribe), código de salida 0, tamaño distinto de cero, `pg_restore --list`, SHA-256 y un `.summary.txt` con el `db:state` previo (sin secretos); la contraseña se toma de `apps/api/.env.migrator` solo en la variable de entorno del proceso y no se imprime.

**Casos límite que quedan como decisiones pendientes antes de cualquier uso real** (conservados a propósito, con pruebas):

1. _Cruzar la medianoche_: un borrador no se guarda ni finaliza al día siguiente (`DAY_NOT_CURRENT`), no se puede cambiar su fecha (trigger) ni forzar una fecha artificial (`DATE_NOT_TODAY`) ni duplicarlo (reabrir hoy devuelve la lista de hoy); Dirección sigue viéndolo y la pantalla explica que ya no puede modificarse desde ese flujo. Falta decidir cómo se cierra o corrige un borrador abandonado.
2. _Padrón cambiado después de abrir_: el padrón está congelado; las altas o traslados posteriores se informan como `discrepancies` (aviso en pantalla) sin incorporar a nadie ni alterar marcas. **Finalizar con discrepancias está permitido** (decisión provisional): la lista finalizada conserva el padrón del momento de apertura y la discrepancia sigue visible. Falta decidir el mecanismo de reconciliación y quién lo autoriza.

## 16. Riesgos y limitaciones

- Política RBAC y reglas **provisionales**: requieren ratificación institucional antes de usar datos reales; MFA sigue pospuesto (solo desarrollo local).
- Sin cuentas reales hasta resolver el bootstrap escolar (D-ESC); la asistencia en la base real no se ha probado con filas reales bajo `eta15_api` (se cubrió en clúster desechable).
- Sin calendario no lectivo: una lista de un día festivo podría abrirse. Un borrador que cruza la medianoche queda sin finalizar.
- La lista abierta congela el padrón: un alumno que llega ese día no puede marcarse hasta decidir el mecanismo (se informa como discrepancia).
- Sin corrección formal ni reportes; sin Android ni offline; un solo cliente web de prueba.
- El historial por renglón lo escribe el servicio en la misma transacción (no un trigger): un cambio directo del propietario por consola no genera evento (igual que alumnos y prefectura); la inmutabilidad de lo ya escrito sí la fuerzan los triggers.
