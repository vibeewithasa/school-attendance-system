# Asignaciones de grupos a prefectura y alcance `assigned_groups`

Estado: **implementado y validado SOLO en entornos aislados** (rama `feat/prefect-group-assignments`, sin commit). La migración **0009** y la propuesta de privilegios **0004**
**NO están aplicadas en `eta15_dev`** (sigue con 9 migraciones, 13 tablas, sin cuentas ni asignaciones). Política RBAC y reglas son **técnicas del MVP, pendientes de ratificación institucional**.

## Requisitos de la escuela y política técnica provisional

- Hay tres prefectas; cada una consulta **únicamente** los grupos que tenga asignados y puede recibir varios. Nada se asigna automáticamente: **Dirección** administra.
- **Política técnica provisional**: un grupo puede tener **más de una prefecta autorizada a la vez** (p. ej. cobertura temporal), pero la futura lista de asistencia será **una sola por grupo y fecha**,
  sin importar cuántas prefectas puedan atenderlo. Esto se resolverá en el módulo de asistencia (quién captura, qué pasa si dos capturan); aquí solo se autoriza la lectura.
- No se define todavía el protocolo offline ni se implementa asistencia ni la app Android.

## Modelo (`prefect_group_assignments`, migración 0009)

| Campo                                           | Notas                                                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                            | UUID v7                                                                                                                                                                         |
| `user_id`                                       | FK a `users` (RESTRICT). Cuenta escolar activa con el rol `prefectura` vigente (trigger)                                                                                        |
| `school_year_id`, `group_id`                    | Redundancia **controlada**: FK compuesta `(group_id, school_year_id)` → `groups(id, school_year_id)` obliga a que el grupo sea del ciclo; el servidor deduce el ciclo del grupo |
| `starts_on`, `ends_on`                          | Periodo **inclusivo** (`ends_on` es el último día con acceso); `ends_on` NULL = sin fecha de fin (dura hasta el fin del ciclo o hasta cerrarla)                                 |
| `created_by`                                    | Quién asignó (la sesión; nunca el cliente)                                                                                                                                      |
| `revoked_at`, `revoked_by`, `revocation_reason` | Revocación inmediata. `revoked_at` lo fija el trigger con `now()`; las tres van juntas o ninguna (CHECK)                                                                        |
| `created_at`, `updated_at`                      | `updated_at` por trigger                                                                                                                                                        |

**Por qué los campos de revocación y no solo `ends_on`**: cerrar por fecha termina el acceso al acabar un día; una revocación extraordinaria debe quitarlo **en ese instante** y conservar quién, cuándo y por qué sin
alterar el periodo programado. Son tres hechos distintos que no se mezclan:

| Hecho                        | Cómo se registra                                                | Efecto                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Cierre programado**        | `ends_on` (NULL → fecha, o acortar una fecha futura)            | Acceso hasta el final de ese día. No se extiende ni se reabre (para ampliar se crea otra)                                       |
| **Revocación inmediata**     | `revoked_by` + `revocation_reason` (+ `revoked_at` del trigger) | Sin acceso en la siguiente petición. La fila queda como historia **inmutable**: no se reabre, no se corrige, no recupera acceso |
| **Historial administrativo** | La fila completa                                                | Nunca se borra (`DELETE`/`TRUNCATE` bloqueados incluso al propietario). Una revocación no cambia `ends_on`                      |

### Integridad en la base

- **Sin traslapes ni duplicados por par**: `EXCLUDE USING gist (user_id WITH =, group_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&) WHERE (revoked_at IS NULL)` (`btree_gist`, instalada en 0007). Periodos
  consecutivos (fin 10, inicio 11) sí; el mismo día no. Las revocadas quedan fuera del índice (son historia): se puede asignar de nuevo el mismo par, como decisión nueva y fila nueva.
  **Un grupo puede tener varias prefectas**: la restricción es por par prefecta-grupo, no por grupo.
- **Alta** (`pga_guard_insert`, SECURITY INVOKER, `search_path` fijo, sin EXECUTE para PUBLIC): cuenta `users.status = 'active'` y de dominio `school`; rol `prefectura` vigente; grupo **activo**; periodo dentro del
  ciclo; **sin retroactividad** (`starts_on >= hoy`: nadie reescribe quién atendió un grupo antes de hoy); nace sin revocación. Bloquea con `FOR SHARE` la cuenta, su rol, el grupo y el ciclo para serializar con
  desactivaciones, revocaciones de rol, cambios de grupo y de fechas del ciclo simultáneos (probado con conexiones reales en ambos órdenes).
- **Cambio** (`pga_guard_update`): identidad e inicio inmutables (`42501`); solo cierre hacia adelante o revocación; una fila revocada es completamente inmutable; no se revoca una asignación que ya terminó.
- **Fechas del ciclo**: `school_years_guard_prefect_dates` impide que un cambio de fechas deje asignaciones fuera del ciclo (el catálogo responde 409).
- Sin `ON DELETE CASCADE` en ninguna FK. Códigos: `23P01` traslape, `23503` referencia, `23514` regla de negocio (CONSTRAINT nombrado), `42501` inmutabilidad o privilegio.
- **Auditoría**: todas las mutaciones por la API se auditan en la misma transacción (`prefect_assignment.created|closed|revoked`, `roster.viewed`, `authz.denied`) con **IDs**, nunca nombres de alumnos
  ni el texto del motivo (solo su longitud). No hay trigger de auditoría de base: un cambio directo del propietario por consola no genera evento (igual que alumnos); se acepta porque el propietario es la consola con persona presente.

## Qué ocurre cuando… (acceso EFECTIVO, evaluado en cada petición)

El acceso `assigned_groups` de una persona hoy son los grupos de asignaciones **no revocadas**, vigentes hoy (inicio ≤ hoy ≤ fin, o sin fin), dentro del ciclo, de un grupo **activo**, de una cuenta escolar **activa y no
bloqueada** que **conserva el rol `prefectura` vigente concedido antes de la asignación**. Se calcula dentro de la transacción de la consulta (`pgGroupAssignments(tx)`); no se confía en que la asignación fue válida al crearse.

| Situación                                        | Efecto en el acceso                                                                    | Historial                                                                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Se desactiva a la prefecta (`status = disabled`) | Inmediato: la sesión muere (401) y, aun con una sesión, la consulta no devuelve grupos | Se conserva; la asignación sigue "vigente" pero con `grantsAccess = false`                                                                                    |
| Se revoca el rol `prefectura`                    | Inmediato (el trigger de roles revoca sus sesiones; además la consulta exige el rol)   | Se conserva. Si se **vuelve a conceder** el rol, las asignaciones previas **no reviven** (el rol debe ser anterior a la asignación): hay que asignar de nuevo |
| Cuenta bloqueada (`locked_until`)                | Sin acceso mientras dure el bloqueo                                                    | Se conserva                                                                                                                                                   |
| Se revoca su sesión                              | 401 inmediato; la cuenta puede volver a entrar                                         | Sin cambios                                                                                                                                                   |
| Se desactiva el grupo                            | Sin acceso a ese grupo; no se pueden crear asignaciones nuevas a él                    | Se conserva                                                                                                                                                   |
| Termina el ciclo                                 | Sin acceso (aunque la asignación no tenga fecha de fin); estado `completed`            | Se conserva                                                                                                                                                   |
| Termina una asignación (`ends_on`)               | Acceso hasta el final de ese día (inclusivo)                                           | Estado `closed`                                                                                                                                               |
| Se revoca una asignación hoy                     | Inmediato (la siguiente petición); verificado con una sesión viva en el navegador      | Estado `revoked` con quién, cuándo y motivo; inmutable                                                                                                        |
| La prefecta cambia de grupo                      | Se cierra o revoca la anterior y se crea otra (no hay "mover")                         | Ambas quedan                                                                                                                                                  |
| Dos solicitudes concurrentes                     | Una gana: el `EXCLUDE` y los bloqueos serializan; la otra recibe 409                   | Una sola fila                                                                                                                                                 |

## Alcance `assigned_groups` sobre alumnos

El puerto `GroupAssignments` (de `authorize.ts`) ya no es provisional: `noGroupAssignments` se **eliminó**; `createStudentsService` exige la fábrica `assignments(tx)`. Con la tabla ausente o sin privilegios (0009/0004 sin aplicar)
el puerto devuelve el conjunto **vacío** (SAVEPOINT, sin abortar la transacción): cero filas, jamás "sin filtro".

- Se aplica **dentro de la consulta**: listado, búsqueda, filtro por grupo, paginación y total, detalle y lista de grupo. Fuera de alcance = **404 indistinguible** de inexistente (mismo cuerpo).
- La identidad sale de la sesión. Ningún parámetro (`userId`, etc.) decide "mis grupos" (`/me/groups` rechaza cualquier query).
- **Con alcance limitado se restringen filtros que revelarían otros periodos**: `schoolYearId` y `asOf` responden `400 FILTER_NOT_ALLOWED`; `groupId` solo acota dentro del alcance.
- **Proyección mínima de prefectura** (`students:read_basic`): `id`, nombres, apellidos, `isActive`, grupo vigente. **Sin** `schoolCode` (ahora es del expediente: `students:read`) ni poder buscar por código (sería leerlo),
  sin sellos de tiempo, sin matrículas ni historial (`students:read` ya no se le concede), sin CURP/domicilio/fecha de nacimiento (no existen en el modelo), sin datos de cuentas ni auditoría.
- Dirección conserva sus permisos; `admin_tecnico`, `trabajo_social` y `control_acceso` siguen sin acceso (403 + `authz.denied`).

## RBAC (migración 0009, política técnica pendiente de ratificación)

| Permiso                                               | Dominio | Direccion |   Prefectura    | Otros |
| ----------------------------------------------------- | ------- | :-------: | :-------------: | :---: |
| `prefect_assignments:manage` (nuevo, no de autoridad) | school  |    all    |        —        |   —   |
| `prefect_assignments:read` (nuevo, no de autoridad)   | school  |    all    |     **own**     |   —   |
| `students:read_basic`                                 | school  |    all    | assigned_groups |   —   |
| `students:read`                                       | school  |    all    |  **retirado**   |   —   |

**Por qué en la misma migración**: la baja de `students:read` a prefectura y el alta de los permisos nuevos son datos de configuración del mismo cambio funcional y deben aplicarse juntos con la tabla (la API ya no
concede el expediente a prefectura en el código). Marca `-- eta15:allow-destructive` justificada solo por ese `DELETE` de una asignación concreta (reversible con una migración nueva); verificación final que revierte todo si
la matriz no es la esperada. Resultado esperado al aplicarla: 29 permisos, 37 asignaciones, 13 eventos de auditoría. Los permisos **no son de autoridad** (no delegan acceso a cuentas ni roles); `admin_tecnico` no puede recibirlos (FK de dominio).
La API **no** escribe `role_permissions`.

## API (`/school`, sesión + MFA gate; mutaciones con CSRF y Origin; sin `DELETE`)

| Ruta                                                                                           | Permiso               | Notas                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /prefect-candidates?q=`                                                                   | `manage`              | Prefectas elegibles: cuenta activa con rol vigente (id, nombre, correo)                                                                                    |
| `GET /prefect-assignments` (`userId`, `schoolYearId`, `groupId`, `status`, `page`, `pageSize`) | `read`                | `all`: historial completo; `own`: solo las suyas, sin `createdBy`/`revokedBy`/motivo                                                                       |
| `GET /prefect-assignments/:id`                                                                 | `read`                | Fuera de alcance = 404                                                                                                                                     |
| `POST /prefect-assignments` `{userId, groupId, startsOn?, endsOn?}`                            | `manage`              | Cuerpo estricto: sin actor ni ciclo. Errores: `USER_NOT_ELIGIBLE`, `GROUP_INACTIVE`, `PAST_START`, `OUT_OF_YEAR`, `OVERLAPS_EXISTING`, `UNKNOWN_REFERENCE` |
| `POST /prefect-assignments/:id/close` `{endsOn?}`                                              | `manage`              | Cierre programado; idempotente; `CANNOT_EXTEND`, `PAST_END`, `ALREADY_REVOKED`                                                                             |
| `POST /prefect-assignments/:id/revoke` `{reason}`                                              | `manage`              | Inmediata; motivo 3–200 caracteres sin control; `ALREADY_REVOKED`, `ALREADY_ENDED`                                                                         |
| `GET /me/groups`                                                                               | `read`                | Grupos que dan acceso **hoy** a la persona autenticada (contrato Android)                                                                                  |
| `GET /groups/:id/roster`                                                                       | `students:read_basic` | Lista del grupo (contrato Android); 404 si no está en el alcance                                                                                           |

Sin la tabla o los privilegios 0004 la administración responde `503 PREFECT_ASSIGNMENTS_UNAVAILABLE` sin detalles internos y la prefectura ve cero alumnos.

## Consultas mínimas para Android (solo backend; sin cliente)

- `GET /school/me/groups` → `{ asOf, generatedAt, groups: [{ assignmentId, group: {id, schoolYearId, schoolYearName, grade, code, shift}, startsOn, endsOn }] }`.
- `GET /school/groups/:id/roster` → `{ asOf, generatedAt, group, students: [{ id, givenNames, familyName }] }` (tope 1000). Sin código escolar, expediente, historial ni sellos. El servidor filtra **antes**: el
  dispositivo nunca descarga alumnos de otros grupos. Cada descarga se audita (`roster.viewed`, id de grupo y conteo).
- `asOf`/`generatedAt` son el punto de extensión: una futura concesión offline firmada podrá incluirlos junto a la vigencia sin cambiar la forma de los datos.
- **Revocación**: en línea es **inmediata** (la siguiente petición falla). Un dispositivo **sin conexión no recibe el aviso hasta que se reconecte**; por eso la concesión offline futura deberá tener vigencia corta y
  revalidarse contra la asignación vigente de cada grupo y fecha al sincronizar (decisión del módulo de asistencia, no definida aquí). No hay tokens offline, concesiones firmadas ni sincronización.

## Privilegios PostgreSQL (propuesta 0004, no aplicada)

`tools/db/privileges/0004-prefect-assignments-write.{proposal,apply,verify}.sql`: **todo por columna**: `SELECT` (todas salvo `updated_at`), `INSERT (user_id, school_year_id, group_id, starts_on, ends_on, created_by)`,
`UPDATE (ends_on, revoked_by, revocation_reason)` (3 `GRANT`). Nunca `DELETE`, `TRUNCATE`, `TRIGGER`, `REFERENCES`, `CREATE`, `GRANT OPTION` ni escritura sobre `role_permissions`. Los triggers de la 0009 son `SECURITY INVOKER`: leen
`users`, `user_roles`, `roles`, `groups` y `school_years` con los privilegios **ya aprobados** (no se amplía ninguno; el preflight lo verifica y exige que existan `SELECT` de columna y algún `UPDATE` de columna para `FOR SHARE`).
Nada concede acceso a secretos de autenticación (`password_hash`, tokens, sesiones). Se aplica con `pnpm db:apply-privileges 0004-prefect-assignments-write --sha256=<hash>` (ensayo con `ROLLBACK`; luego `--execute`).
**Dependencia**: igual que con 0007, cambiar las **fechas** de un ciclo lee estas asignaciones con los privilegios de la API; sin 0004 esa operación del catálogo responde 503 (nada más se afecta).

## Interfaz (`/prefectura`, enlace «Asignaciones de prefectura»)

Solo con `prefect_assignments:read` con alcance `all` (Dirección). Lista con filtros por prefecta, ciclo y estado, historial (revocadas con motivo), aviso «sin efecto hoy» cuando una vigente no da acceso
(cuenta, rol o grupo), «Asignar grupos» (prefecta, ciclo, varios grupos, fechas, cobertura temporal; una asignación por grupo, conserva lo creado si una falla), «Cerrar» (fecha) y «Revocar» (motivo y advertencia de efecto inmediato).
Validación previa, foco al primer campo inválido, responsive (la navegación ahora admite varias filas), tinto y blanco. La prefectura no ve controles de administración (la app Android será su cliente).

## Pruebas (2026-10-27)

Recuento: 864 unitarias (738 API + 126 React), 34 de integración (base real, solo lectura) y 359 en el clúster desechable.

PGlite: migración 0009 (20 casos), servicio con «hoy» inyectado, HTTP completo (29, con dos prefectas ficticias y acceso horizontal) y la política RBAC; clúster PostgreSQL 18 desechable con los privilegios reales de `eta15_api`
(47 casos con matriz por columna, privilegios de más y de menos, y **concurrencia real**: altas simultáneas del mismo par, cobertura sin bloqueo, revocar rol vs asignar en ambos órdenes, cerrar vs revocar, desactivar grupo vs asignar,
acortar el ciclo vs asignar en ambos órdenes); ejecución controlada de 0004 (17); React (14). Navegador real (sandbox aislado): Dirección crea ciclo y grupos, asigna grupos a dos prefectas (cobertura compartida en 1.º B),
cada prefecta ve solo sus alumnos y nada más (404/403), y **revocar 1.º B a una prefecta con sesión viva le quita esos alumnos en menos de un segundo**; móvil de 375 px sin desbordes.

## Riesgos y decisiones institucionales pendientes

1. ¿Un grupo con varias prefectas simultáneas es definitivo o solo cobertura? (afecta la asistencia: lista única, ¿quién captura y quién corrige?).
2. Quién aprueba cambios y coberturas, y si exige doble control (hoy basta Dirección con MFA, que sigue pospuesto en desarrollo).
3. Las tres cuentas reales de prefectura dependen del bootstrap escolar (D-ESC): sin ellas, no hay datos reales.
4. Retroactividad: se prohíbe a propósito; una corrección histórica (p. ej. quién atendió un grupo la semana pasada) requeriría un procedimiento explícito y migración/consola.
5. Vigencia y revalidación de las concesiones offline de Android (tiempo máximo sin conexión, qué pasa con capturas hechas tras una revocación).
6. Si la prefecta debe ver el código escolar del alumno (hoy no).
7. Auditoría de cambios hechos directamente por la consola del propietario (hoy no hay trigger).
