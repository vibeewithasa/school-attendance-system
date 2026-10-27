# Modelo de alumnos, matrículas por ciclo e historial de grupo

Estado: **implementado y APLICADO en `eta15_dev` el 2026-10-27, sin ningún dato** (migraciones 0007 y 0008, privilegios 0003; commit de implementación `674bc4f` en la rama `feat/students-enrollments`).
**Sin autorización para datos reales de menores** (ver [Decisiones institucionales pendientes](#decisiones-institucionales-pendientes)).

## Política de datos mínimos (menores de edad)

Solo se guarda lo imprescindible para identificar al alumno dentro de la escuela:

| Dato                         | Estado           | Razón                                                                             |
| ---------------------------- | ---------------- | --------------------------------------------------------------------------------- |
| Nombre(s) y apellidos        | Sí               | Identificación en listas, grupos y (más adelante) asistencia                      |
| Código escolar (opcional)    | Sí               | Identificador **administrativo** (no es secreto ni credencial); único si existe   |
| Activo / inactivo            | Sí               | Baja lógica: nada se borra                                                        |
| CURP                         | **No** por ahora | Identificador oficial sensible; requiere decisión y justificación institucional   |
| Fecha de nacimiento          | **No** por ahora | Sin necesidad documentada en el MVP                                               |
| Tutores, teléfono, dirección | **No** por ahora | Datos de contacto/terceros: requieren aviso de privacidad y política de retención |
| Fotografía                   | **No** por ahora | Dato biométrico/sensible de menores                                               |
| Datos médicos, discapacidad  | **No** por ahora | Categoría especial; fuera de alcance                                              |
| Importación masiva           | **No** por ahora | Se diseñará con validación y revisión antes de cargar datos                       |

Los alumnos **no son cuentas de acceso** (no hay correo ni contraseña) y el módulo no crea usuarios de Auth. La auditoría registra IDs y nombres de
campos, **nunca** nombres de menores ni el texto de las búsquedas. Las respuestas no incluyen campos que no existan en el modelo.

## Modelo

- **`students`**: `id` (UUID v7, estable), `given_names`, `family_name`, `school_code` (opcional, único; mayúsculas ASCII, dígitos y guiones, 1–20),
  `is_active`, `created_at`, `updated_at`. El **nombre nunca es clave** (los homónimos son válidos). La base rechaza nombres sin recortar, con espacios dobles
  o caracteres de control (la API además normaliza a NFC y exige letras, apóstrofo, guion y punto).
- **`enrollments`** (matrícula): `student_id`, `school_year_id`, `starts_on`, `ends_on` (NULL = sin baja). **A lo más una por alumno y ciclo**
  (`UNIQUE(student_id, school_year_id)`); el historial entre ciclos son varias filas. No contiene el grupo: un cambio de grupo no toca la matrícula.
- **`student_group_assignments`** (historial de grupo): `enrollment_id`, `school_year_id`, `group_id`, `starts_on`, `ends_on` (NULL = vigente).

### Convención de fechas

Todas las fechas son **días de calendario** de la escuela (America/Mazatlan) y los periodos son **inclusivos en ambos extremos**: `ends_on` es el último día
(igual que los ciclos escolares). Un periodo consecutivo empieza el día siguiente; dos periodos que comparten un día **se traslapan**.

**Traslado dentro del mismo día.** Como el modelo no tiene horas, un alumno no puede estar en dos grupos el mismo día. Un traslado con fecha efectiva `E` cierra
el grupo anterior en `E − 1` y abre el nuevo en `E`; por eso `E` debe ser **posterior** al día en que empezó el grupo vigente. Si coincide, la API responde
`409 SAME_DAY` con un mensaje explícito (no se inventan horarios ni se reescribe el historial). Corregir una asignación del mismo día es una corrección
histórica y queda **bloqueada** hasta que la institución defina el procedimiento.

### Integridad en la base (migración 0007)

- **Mismo ciclo sin triggers**: la asignación repite `school_year_id` (redundancia **controlada**) para dos FK compuestas: `(enrollment_id, school_year_id)` →
  `enrollments(id, school_year_id)` y `(group_id, school_year_id)` → `groups(id, school_year_id)` (esta última usa la clave única ya existente). Un grupo de otro ciclo
  o una asignación sin matrícula falla con `23503`.
- **Sin traslapes**: `EXCLUDE USING gist (enrollment_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&)` (`23P01`), más un índice único parcial que permite **a lo más un
  periodo vigente** por matrícula (`23505`). Es declarativo, así que también protege frente a carreras entre transacciones.
- **`btree_gist`**: el `EXCLUDE` necesita igualdad de `uuid` junto con rangos. Es una extensión **de confianza** (PostgreSQL ≥ 13): la instala el propietario de la base
  (`eta15_app`, sin ser superusuario; probado en el clúster desechable) y queda en su **propio esquema `extensions`**, para que las auditorías de funciones de `public` sigan
  intactas. Está disponible en el servidor real (`pg_available_extensions`, versión 1.8, `trusted`) y **quedó instalada al aplicar 0007** (`btree_gist 1.8` en el esquema `extensions`, propiedad de `eta15_app`; `eta15_api` sin `USAGE` ni `CREATE` sobre él, comprobado por el verificador y por las pruebas de integración).
- **Triggers** (`SECURITY INVOKER`, `search_path` fijo, sin `EXECUTE` para `PUBLIC`): sin `DELETE`/`TRUNCATE` ni siquiera para el propietario (`42501`); el `id` y los
  sellos de creación no cambian; la matrícula exige alumno **activo** (con `FOR SHARE`, para serializar con una desactivación simultánea) y fecha de inicio dentro del
  ciclo; la matrícula solo cambia con la **baja** (NULL → fecha, una vez, dentro del ciclo y sin dejar periodos de grupo abiertos o posteriores); el historial de grupo solo se
  **cierra** (NULL → fecha) y todo periodo cae dentro de la matrícula (con `FOR SHARE` de la matrícula).
- **Integridad entre módulos (cierre de auditoría)**: el catálogo puede corregir las fechas de un ciclo vigente. Un trigger de `school_years` (`school_years_guard_dates`, solo al cambiar fechas) rechaza (`23514`, `school_years_enrollments_within`; el catálogo responde 409) cualquier fecha que deje matrículas o periodos de grupo fuera del ciclo, y bloquea con `FOR SHARE` las matrículas del ciclo para serializar con bajas y traslados. A su vez, el alta de matrícula y de periodo de grupo bloquean el ciclo (`FOR SHARE`): acortar el ciclo y matricular a la vez nunca deja una matrícula fuera de las fechas finales (probado con dos conexiones reales). **Desactivar** a un alumno con una matrícula sin baja en un ciclo no terminado también falla en la base (`23514`, `students_deactivate_open_enrollment`, con la fecha de la escuela en America/Mazatlan), aunque se salte el servicio. La **baja** de una matrícula cierra en la misma transacción el periodo de grupo vigente; la base rechaza una baja que deje un periodo abierto o posterior.
- Códigos SQLSTATE: `23505` duplicado, `23P01` traslape, `23503` ciclo/grupo/matrícula inexistente o de otro ciclo, `23514` regla de negocio (con `CONSTRAINT` nombrado), `42501` inmutabilidad o privilegio.

## Reglas de negocio (servicio)

- Ciclos terminados son **historial**: no se inscribe, no se da de baja, no se asigna ni se traslada (`409 HISTORICAL`).
- Inscribir exige alumno activo y ciclo no terminado; inicio por defecto hoy (o el inicio del ciclo si todavía no empieza); una fecha anterior a hoy se admite dentro del ciclo y se audita como `backdated`.
- Desactivar un alumno con matrícula **sin baja** se rechaza (`HAS_OPEN_ENROLLMENT`); reactivar es una operación autorizada y auditada. Un alumno inactivo no recibe matrículas nuevas.
- **Baja**: cierra la matrícula y el grupo vigente en una transacción; no se reabre. Si hay periodos de grupo posteriores a la fecha, se rechaza.
- **Asignar el primer grupo** y **trasladar** exigen matrícula sin baja, grupo **del mismo ciclo** (si no, `GROUP_NOT_IN_YEAR`, igual para inexistente), grupo activo, y un traslado real (`SAME_GROUP` si no tiene efecto). Se ejecutan en una transacción bajo bloqueo de la fila de la matrícula; ante transferencias simultáneas solo una gana.
- Un cambio de grupo no reescribe nada previo: el periodo anterior solo se cierra. **No se modifica retroactivamente asistencia histórica** (aún no existe): cuando exista, cada registro de asistencia deberá guardar la matrícula y el grupo de su día.

## Autorización y privacidad

El módulo usa los permisos que ya existen (no se inventan): `students:read_basic`, `students:read`, `students:manage`, `enrollments:manage`.

| Permiso               | Qué abre                                                                                       | Alcance admitido          |
| --------------------- | ---------------------------------------------------------------------------------------------- | ------------------------- |
| `students:read_basic` | Listar y consultar (nombre, código, estado, **grupo vigente**); es la "puerta" de toda lectura | `all` o `assigned_groups` |
| `students:read`       | Expediente: historial de matrículas y de grupos y sellos de tiempo (proyección por campos)     | `all` o `assigned_groups` |
| `students:manage`     | Alta, corrección, desactivar y reactivar alumnos                                               | solo `all`                |
| `enrollments:manage`  | Inscribir, baja, asignar grupo y trasladar                                                     | solo `all`                |

- **Denegar por defecto**; sin permiso `403` + `authz.denied`. El alcance se aplica **en la consulta** (listados, contadores, búsquedas, filtros y paginación); un conjunto vacío significa **cero filas**,
  nunca "sin filtro". Un recurso fuera de alcance responde **igual que uno inexistente (`404`)**. No hay datos por relaciones SQL sin autorizar.
- **Prefectura** conserva `assigned_groups` pero **no existen asignaciones reales de grupos a prefectura**: hoy no ve nada. **No se implementó** esa tabla (fase posterior).
- **admin_tecnico** no puede recibir permisos de alumnos: lo impide el esquema (dominio). **Dirección** tiene los cuatro.
- **Brecha de la semilla y migración 0008 (aplicada)**: la semilla 0004 dio lectura de alumnos con alcance `all` a `trabajo_social` (`students:read_basic`, `students:read`) y a `control_acceso`
  (`students:read_basic`). Con esos permisos, esos roles verían a todos los alumnos. La migración `0008_students_rbac_policy` (marca `-- eta15:allow-destructive` justificada solo por sus dos `DELETE` de
  asignaciones concretas; verificación final que revierte todo si la matriz no es la esperada; idempotente) las retiró (3 eventos `role.permissions_changed`) para mantener el módulo cerrado por defecto. La propuesta suelta se eliminó al integrarse.
  Resultado en `eta15_dev`: 35 asignaciones (eran 38) y 9 eventos de auditoría (eran 6); solo Dirección (`all`) y prefectura (`assigned_groups`) conservan permisos de alumnos.
- Sesión con la puerta de MFA (`adminGuard`) en toda ruta; CSRF y Origin en las mutaciones; `Cache-Control: no-store`.

## API (`/school`)

| Método y ruta                                   | Permiso                                 | Qué hace                                                           |
| ----------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| `GET /students`                                 | `students:read_basic`                   | Lista paginada; `q`, `isActive`, `schoolYearId`, `groupId`, `asOf` |
| `POST /students`                                | `students:manage`                       | Alta (`givenNames`, `familyName`, `schoolCode?`); 201 + `Location` |
| `GET /students/:id`                             | `students:read_basic`                   | Detalle (campos según permisos)                                    |
| `PATCH /students/:id`                           | `students:manage`                       | Corrige nombres y código (no el id)                                |
| `POST /students/:id/deactivate` · `/reactivate` | `students:manage`                       | Baja lógica / reactivación (idempotentes, auditadas)               |
| `GET /students/:id/enrollments`                 | `students:read_basic` + `students:read` | Matrículas con su historial de grupos                              |
| `POST /students/:id/enrollments`                | `enrollments:manage`                    | Inscribe en un ciclo                                               |
| `GET /enrollments/:id`                          | ídem lectura                            | Una matrícula con su historial                                     |
| `POST /enrollments/:id/withdraw`                | `enrollments:manage`                    | Baja (cierra también el grupo vigente)                             |
| `POST /enrollments/:id/group-assignments`       | `enrollments:manage`                    | Primera asignación de grupo                                        |
| `POST /enrollments/:id/transfer`                | `enrollments:manage`                    | Traslado: cierra en `E−1` y abre en `E`                            |

Sin `DELETE`. Cuerpos estrictos (campos no modelados → `400`, sin eco de la entrada). `503 STUDENTS_UNAVAILABLE` si la base aún no tiene las tablas o los privilegios.
Auditoría: `student.created|updated|deactivated|reactivated|viewed|searched`, `enrollment.created|withdrawn`, `group_assignment.created|transferred`.

## Privilegios de PostgreSQL (0003, aplicados el 2026-10-27)

`tools/db/privileges/0003-students-write.{proposal,apply,verify}.sql`: **todo por columna, incluido `SELECT`** (una columna futura no es legible ni escribible por la API hasta concederla):
`students` SELECT (todas) · INSERT (`given_names, family_name, school_code`) · UPDATE (`given_names, family_name, school_code, is_active`); `enrollments` SELECT (todas) · INSERT (`student_id, school_year_id, starts_on`) ·
UPDATE (`ends_on`); `student_group_assignments` SELECT (todas salvo `updated_at`) · INSERT (`enrollment_id, school_year_id, group_id, starts_on`) · UPDATE (`ends_on`). Nunca `DELETE`, `TRUNCATE`, `TRIGGER`, `REFERENCES`, `CREATE`, `GRANT OPTION`,
acceso al esquema `extensions` ni escritura sobre `role_permissions`. La API no es propietaria. Se aplicó con `pnpm db:apply-privileges 0003-students-write --sha256=<hash>` (ensayo con `ROLLBACK` y luego `--execute`; preflight + 9 `GRANT` + verificador en **una** transacción), igual que 0002.
Las tablas de 0007 **no heredan** privilegios de `eta15_api` (los `GRANT` de 2026-10-26 solo cubrieron las tablas existentes y el `ALTER DEFAULT PRIVILEGES` solo toca funciones): verificado en el servidor real.

## Interfaz (`/alumnos`)

Sección "Alumnos" (visible con `students:read_basic`): listado con búsqueda (≥ 2 letras) y filtros por ciclo, grupo y estado (los filtros del catálogo solo se ofrecen con `catalog:read`); registro y corrección (solo nombre, apellidos
y código opcional); detalle con matrículas por ciclo e historial de grupos (con `students:read`); inscribir, asignar grupo, trasladar y dar de baja (con `enrollments:manage`); desactivar/reactivar con confirmación. Validación previa, foco al primer campo con error,
mensajes del servidor sin datos internos, responsive y sin controles para acciones no permitidas.

## Pruebas

- **Migración 0007** incremental sobre 0000–0006 (estructura, restricciones y triggers, incluida la integridad con las fechas del ciclo y con la desactivación); **0008** incremental sobre 0000–0007 (3 bajas, 3 eventos de auditoría, nada más cambia, idempotente, verificación final).
- **Servicio** con permisos sintéticos (alcance por grupos, proyección, indistinguibilidad 404, módulo no habilitado); **HTTP** completo en PGlite y en un **clúster PostgreSQL 18 desechable con los privilegios reales de `eta15_api`**, con concurrencia real de varias conexiones (inscripciones, traslados, baja vs traslado, traslape, desactivar vs inscribir, acortar el ciclo vs inscribir y a la inversa).
- **Privilegios**: matriz por columna, ejecución controlada de 0003 (ensayo, `COMMIT`, idempotencia, rollback si el verificador falla, preflight que exige 0002 y 0007) y verificador estricto.
- **Interfaz**: pruebas de componentes (jsdom) y una pasada manual en el navegador integrado contra `pnpm dev:sandbox -- --catalog-write --students-write` (ver `estado-del-proyecto.md`).
- **Base real** (`pnpm test:integration`, solo lectura): matriz de privilegios, columnas exactas de 0003, `extensions` inaccesible y política RBAC de alumnos.
- Recuento al 2026-10-27: 792 unitarias (680 API + 112 React), 34 de integración, 295 en clúster desechable. Todos los datos son ficticios.

## Procedimiento de aplicación y restauración

Aplicado en `eta15_dev` el 2026-10-27 (host 127.0.0.1:5432, `eta15_app`, PostgreSQL 18.0), en este orden:

1. Preflight de solo lectura con `pnpm db:state` (7 migraciones, 10 tablas, 0 usuarios/alumnos/ciclos/grupos, 38 asignaciones, 6 eventos, solo `plpgsql`, sin _drift_: los hashes aplicados son prefijo de los locales) y SHA-256 del SQL exacto (0007 `A2239BDC…CC112`, 0008 `5E1F4422…BCD48`, apply 0003 `59FCB15D…4185F`).
2. Respaldo `pg_dump -Fc` fuera del repositorio (`C:\Users\asahe\Backups\ETA15\eta15_dev_pre-0007-0008_20261027-000611.dump`), `pg_restore --list` correcto, SHA-256 `3245BAAF7DA7E30FADD8634A2C3640BC9525C67E925EF1410B10759A0EADF983` y resumen no sensible junto a él.
3. `pnpm db:migrate` (envoltorio protegido; exige `apps/api/drizzle` confirmado en Git): 9 migraciones, 13 tablas, `btree_gist 1.8` en `extensions`, 35 asignaciones, 9 eventos.
4. `pnpm db:apply-privileges 0003-students-write --sha256=<hash>` (ensayo con `ROLLBACK`) y después `--execute`: preflight + 9 `GRANT` + verificador en una sola transacción.
5. Verificación como `eta15_api` dentro de `BEGIN … ROLLBACK` con datos ficticios (operaciones autorizadas funcionan; `DELETE`, `TRUNCATE`, `CREATE`, `SET ROLE eta15_app`, columnas no concedidas y escritura de `role_permissions` fallan con `42501`; traslape, grupo de otro ciclo, desactivar con matrícula sin baja y acortar el ciclo fallan con `23P01`/`23503`/`23514`); después no quedó ningún alumno, matrícula, ciclo, grupo ni usuario.

**Restauración** (solo con autorización explícita; destruye lo posterior al respaldo): detener la API, `pg_restore --list` del `.dump` para confirmarlo, restaurar sobre una base vacía o con `pg_restore --clean --if-exists -d eta15_dev` como `eta15_app`, volver a comprobar `pnpm db:state` y los privilegios (`pg_dump` **no** respalda roles ni sus contraseñas; ver `roles-postgresql.md`). Como las migraciones nuevas solo agregan objetos y quitan tres asignaciones de configuración, otra opción más segura es una migración correctiva que las recree, sin restaurar el respaldo.

## Decisiones institucionales pendientes

Hasta que se resuelvan, la funcionalidad afectada queda **bloqueada o limitada** (no se improvisan reglas):

1. **Identificador oficial** (CURP, matrícula SEP u otro) y su tratamiento: hoy solo existe el código escolar interno opcional.
2. **Tutores y contacto**, aviso de privacidad, consentimiento y política de **retención** de datos de menores.
3. **Fotografía** y datos de salud o discapacidad: fuera del modelo.
4. **Altas masivas** (importación): sin diseñar; requiere formato, validación y revisión previa.
5. **Reinscripción en el mismo ciclo tras una baja** y reapertura de bajas: hoy no existe (una matrícula por alumno y ciclo; la baja no se reabre).
6. **Correcciones históricas** (cambiar fechas de matrícula o de grupo ya registradas, o corregir una asignación del mismo día): sin procedimiento; el modelo las impide y la base las bloquea.
7. **Quién puede ver qué** para `trabajo_social` y `control_acceso` (hoy sin acceso tras 0008) y las asignaciones reales de **prefectura** a grupos.
8. **Motivos de baja** (catálogo oficial): no se guardan porque la institución no los ha definido.
9. Búsqueda **sin acentos** (hoy distingue acentos; `unaccent` no se instala): decisión de uso.
10. Ratificación institucional de la **política RBAC** (catálogo y alumnos) antes de usar datos reales; MFA sigue pospuesto solo en desarrollo local.
