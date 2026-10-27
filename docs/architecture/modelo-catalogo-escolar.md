# Modelo del catálogo escolar (`school_years`, `groups`)

Estado: **migraciones 0000, 0001 y 0002 aplicadas en `eta15_dev` (PostgreSQL 18.0 local) el 2026-10-25**; ver [Aplicación real](#aplicación-real-en-eta15_dev). Esquema Drizzle:
`apps/api/src/db/schema/school-catalog.ts`. Migraciones: `apps/api/drizzle/0000_school_catalog.sql` (generada)
y `0001_school_catalog_integrity.sql` (escrita a mano, registrada en el journal de Drizzle).

## Modelo

```
school_years 1 ──< groups
```

### `school_years` (ciclos académicos)

| Columna                    | Tipo        | Notas                                                                          |
| -------------------------- | ----------- | ------------------------------------------------------------------------------ |
| `id`                       | uuid PK     | `DEFAULT uuidv7()` (nativo en PostgreSQL 18); también generable en cliente     |
| `name`                     | text        | Único, p. ej. `2025-2026`; sin espacios en los bordes                          |
| `starts_on`, `ends_on`     | date        | Ambas **inclusivas**; `ends_on > starts_on`                                    |
| `is_active`                | boolean     | `true` = ciclo vigente; por defecto `false` (permite registrar ciclos futuros) |
| `created_at`, `updated_at` | timestamptz | `updated_at` lo actualiza un trigger                                           |

### `groups`

| Columna                    | Tipo         | Notas                                                                                                      |
| -------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| `id`                       | uuid PK      | `uuidv7()`                                                                                                 |
| `school_year_id`           | uuid FK      | `NOT NULL` → `school_years(id)`, `ON DELETE/UPDATE RESTRICT`                                               |
| `grade`                    | smallint     | 1 a 3                                                                                                      |
| `code`                     | text         | Identificador del grupo, 1–10 caracteres, **ya normalizado** (ver abajo)                                   |
| `shift`                    | text NULL    | `matutino` / `vespertino`; `NULL` si no se distinguen turnos                                               |
| `expected_entry_time`      | time(0) NULL | Hora de entrada esperada (hora local, sin zona horaria); `NULL` = sin configurar. Migración 0002, aplicada |
| `is_active`                | boolean      | Por defecto `true`                                                                                         |
| `created_at`, `updated_at` | timestamptz  | Igual que arriba                                                                                           |

## Reglas definitivas

1. `school_years` son ciclos académicos con fecha de inicio y de fin.
2. **Sin traslape**, con fechas inclusivas: si un ciclo termina el 15-jul, el siguiente puede empezar el 16-jul, no el 15-jul.
3. **Un solo ciclo vigente** (`is_active`), pero se pueden registrar ciclos futuros inactivos. Para relevar: desactivar el anterior y activar el nuevo en una transacción.
4. Grados **1 a 3**. No se limita la cantidad de grupos.
5. `code` admite hasta **10 caracteres**: letras A–Z (ASCII) y dígitos, con separadores simples (un espacio o un guion) entre bloques. Ejemplos: `A`, `1A`, `TEC-1`, `TEC 2`.
6. **Normalización**: la forma canónica es mayúsculas, sin espacios en los bordes y sin separadores repetidos. La API la aplica (`normalizeGroupCode`: recorta, colapsa espacios, pasa a mayúsculas) y la BD **rechaza** cualquier valor no canónico. Así el `UNIQUE` simple basta para evitar `a` / `A` / ` A`.
7. Turno opcional. Sin duplicados por ciclo + grado + `code` + turno (`NULL` cuenta como un valor: dos grupos sin turno iguales chocan).
8. La pertenencia histórica de alumnos se registrará en `enrollments` (no implementado). No hay materias ni asistencia por clase en el MVP.
9. **Sin borrado físico (política de aplicación)**: la aplicación desactiva (`is_active = false`) en lugar de borrar. **PostgreSQL no lo garantiza**: `eta15_app` es propietario de las tablas y puede ejecutar `DELETE` sobre `groups` o sobre un ciclo sin grupos. Lo único que impide la BD es borrar o renombrar el id de un ciclo que tenga grupos (FK `RESTRICT`, SQLSTATE `23001`). Si se quiere una garantía dura, habría que revocar `DELETE` al rol de la API (con roles separados en producción, ADR 0003). Agregar ciclos o grupos nuevos no modifica filas existentes.
10. Un grupo pertenece a su ciclo para siempre. La BD **no** impide cambiar `school_year_id` (impedirlo requeriría otro trigger); la API no debe exponerlo. Las matrículas lo respaldarán con la FK compuesta.

## Hora de entrada del grupo (`expected_entry_time`)

**Decisión**: una columna `time(0)` nullable en `groups`, no una tabla nueva.

- **Turno ≠ horario**: `shift` (etiqueta) y `expected_entry_time` son independientes. Un grupo `matutino` puede entrar a las 07:00 o a las 07:50; la unicidad del grupo **no** incluye la hora.
- **Configurable por grupo y sin lista cerrada**: cualquier hora **con precisión de minuto** de 00:00 a 23:59 es válida (07:00 y 07:50 son solo los valores actuales). Dos `CHECK`: descarta `24:00:00` (que PostgreSQL acepta como `time`) y exige segundos = 0 (`07:00:30` se rechaza).
- **`time` sin zona horaria**: es la hora de pared de la escuela; el instante concreto de una entrada se construye con la fecha del evento y la zona horaria de la escuela (America/Mazatlan) al evaluar. Guardarla como `timestamptz` fijaría un día que no existe.
- **`NULL` antes de configurar**: la migración es un `ADD COLUMN` nullable (no reescribe la tabla, no toca datos). Los grupos existentes quedan sin hora hasta configurarlos; el control de acceso deberá tratar `NULL` como "sin horario" y no inventar uno.
- **Fuera de alcance, a propósito**: tolerancia de retardo, cálculo de retardos y eventos de acceso. La asistencia diaria de prefectura y los escaneos de acceso son conceptos independientes: el escaneo no genera ni modifica asistencia.
- **Historial (pendiente de decidir al implementar acceso)**: cambiar `expected_entry_time` en un grupo reescribiría, en apariencia, las evaluaciones pasadas, porque la tabla guarda solo el valor vigente (`updated_at` indica _cuándo_ cambió, no el valor anterior). Recomendación: cuando exista la tabla de eventos de acceso, **cada evento guardará una copia (snapshot) de la hora esperada y de la tolerancia usadas al evaluarlo**. Así el histórico no depende de este campo y no hace falta una tabla de versiones de horarios para el MVP. Si más adelante se necesitaran horarios por fecha (p. ej. horario especial de un día), se evaluaría una tabla de excepciones.

## API y autorización del catálogo (rama `feat/school-catalog-api`, sin commit)

Prefijo `/catalog`. Contratos Zod estrictos en `packages/shared-contracts/src/school-catalog.ts` (los usan la API y la interfaz).
Sin `DELETE` en ninguna ruta: se desactiva. Los errores no incluyen texto de PostgreSQL ni repiten la entrada.

| Método y ruta                       | Permiso                 | Qué hace                                                                                                         |
| ----------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /school-years`, `GET …/:id`    | `catalog:read`          | Lista paginada (`page`, `pageSize` ≤ 100, `isActive`) y detalle; `period` (pasado/vigente/futuro) y `groupCount` |
| `POST /school-years`                | `catalog:manage_school` | Alta (`name`, `startsOn`, `endsOn`); no activa; 201 + `Location`                                                 |
| `PATCH /school-years/:id`           | `catalog:manage_school` | Cambia nombre y/o fechas (al menos un campo)                                                                     |
| `POST /school-years/:id/activate`   | `catalog:manage_school` | Hace vigente el ciclo y desactiva el anterior en la misma transacción; idempotente                               |
| `POST /school-years/:id/deactivate` | `catalog:manage_school` | Quita la vigencia; idempotente                                                                                   |
| `GET /groups`, `GET …/:id`          | `catalog:read`          | Filtros `schoolYearId`, `grade`, `shift` (incluye `none`), `isActive`, `q` (código)                              |
| `POST /groups`                      | `catalog:manage_school` | Alta (`schoolYearId`, `grade`, `code`, `shift?`, `expectedEntryTime?`)                                           |
| `PATCH /groups/:id`                 | `catalog:manage_school` | Cambia `code`, `shift`, `expectedEntryTime` e `isActive`. **No** cambia ciclo ni grado                           |

**Reglas de negocio** (además de las constraints de la BD, que siguen siendo la última defensa):

- "Hoy" es la fecha en `America/Mazatlan`. Solo se **activa** el ciclo que incluye hoy, y el ciclo vigente debe seguir incluyéndolo al editarlo. La activación toma un candado de asesoría (`eta15.school_year.active`) y relee el estado, así que diez activaciones simultáneas dejan un solo vigente.
- Duración de un ciclo: 60 a 400 días (ambos extremos incluidos). Traslapes y nombres duplicados → 409 con mensaje claro.
- **Historial inmutable**: un ciclo cuya fecha de fin ya pasó no se edita y no admite grupos nuevos; sus grupos tampoco se modifican (409 `HISTORICAL`). Los ciclos futuros sí se editan y reciben grupos.
- La hora de entrada es `HH:MM` (también `HH:MM:00`), 00:00–23:59, sin segundos, opcional (`null` = sin configurar) y **independiente del turno**.
- Sin cambios reales (mismo valor) no se escribe ni se audita. Auditoría: `school_year.created|updated|activated|deactivated`, `group.created|updated` (con antes/después de los campos cambiados) y `authz.denied` para los rechazos; sin contraseñas, tokens ni cookies.

**Autorización** (RBAC real; `role_permissions` nunca lo modifica la API): leer exige `catalog:read` y escribir `catalog:manage_school`, ambos con alcance `all` (solo cuentan los permisos con ese alcance). Las mutaciones pasan además por la puerta de MFA (`adminGuard`), CSRF (Origin + Fetch Metadata + token ligado a la sesión) y límite de peticiones. Un usuario autenticado cualquiera no administra el catálogo.

### Política RBAC del catálogo (propuesta técnica del MVP, pendiente de ratificación institucional antes del uso real)

| Rol                                | Consulta | Administra ciclos y grupos  | Nota                                                                                                                                  |
| ---------------------------------- | :------: | :-------------------------: | ------------------------------------------------------------------------------------------------------------------------------------- |
| `direccion` (escolar)              |    ✓     | ✓ (`catalog:manage_school`) | Solo dentro del dominio escolar; con MFA (diferido solo en desarrollo local), CSRF, auditoría y sesiones                              |
| `admin_tecnico` (técnico)          |    —     |              —              | Conserva sus permisos técnicos; **sin** acceso al catálogo (no lo necesita para funcionar), sin autoridad escolar ni datos de alumnos |
| `prefectura`                       |    —     |              —              | Sin `catalog:read` global: lo tendrá con alcance `assigned_groups` cuando exista y esté probado                                       |
| `trabajo_social`, `control_acceso` |    —     |              —              | Sin lectura hasta que exista un requerimiento funcional                                                                               |

**Diagnóstico original.** `catalog:manage` se sembró (0004) con dominio `technical` y solo `admin_tecnico` lo recibió, así que `direccion` (rol escolar) obtenía 403. No bastaba cambiar un arreglo de permisos en TypeScript: el esquema lo impide en tres capas. `role_permissions_domain_match` (CHECK) y la FK compuesta `(permission_id, permission_domain)` solo admiten permisos del dominio del rol o `shared`; `permissions_guard` hace inmutables clave, dominio y `is_authority`; y `role_permissions_guard` impide `UPDATE`. Por eso la corrección no relaja ninguna guarda: crea un permiso **nuevo** del dominio escolar.

**Migración 0006** (`0006_catalog_rbac_school_management.sql`; **aplicada en `eta15_dev` el 2026-10-26**, tras preflight, respaldo y pruebas): crea `catalog:manage_school` (dominio `school`, no de autoridad) y se lo concede a `direccion`; quita `catalog:manage` y `catalog:read` a `admin_tecnico` y `catalog:read` a `prefectura`, `trabajo_social` y `control_acceso`. El permiso técnico `catalog:manage` queda definido y **sin asignar** (reservado; retirarlo es una limpieza futura opcional). No toca 0000–0005, no crea usuarios ni borra roles o permisos, y termina con una verificación que revierte toda la migración si el resultado no es el esperado. Lleva la marca `-- eta15:allow-destructive` solo porque las bajas de asignaciones son `DELETE`; es idempotente. Cada alta/baja queda auditada por el trigger `role_permissions_audit` (**6 eventos `role.permissions_changed`** (1 alta y 5 bajas) sin actor; al aplicarla, `audit_events` de `eta15_dev` pasó de 0 a 6 filas, lo esperado y comprobado). Pruebas: `test/catalog-rbac.migration.test.ts` (incremental desde 0005), `test/auth-seed.test.ts` (el catálogo en código coincide con la base tras 0006) y las suites HTTP.

> **Decisión que ratifica la institución (D-CAT)**: (1) que solo Dirección administre el catálogo; (2) retirar la lectura global a prefectura, trabajo social y control de acceso hasta que haya requerimiento. Ambas son reversibles con una migración nueva.

**Privilegios de PostgreSQL**: `eta15_api` tenía solo `SELECT` sobre `school_years` y `groups` (ver [roles-postgresql.md](roles-postgresql.md)); ahora, además, escritura por columna. Se aplicó la propuesta `tools/db/privileges/0002-school-catalog-write.proposal.sql`, ahora **por columna también en `INSERT`** (solo las columnas que usan los servicios: ciclos `name, starts_on, ends_on`; grupos `school_year_id, grade, code, shift, expected_entry_time`; `UPDATE` de ciclos `name, starts_on, ends_on, is_active` y de grupos `code, shift, expected_entry_time, is_active`). Quedan fuera `id`, `created_at`, `updated_at` (los fijan el `DEFAULT` y el trigger), `is_active` en el alta y, en `UPDATE`, `school_year_id` y `grade`; nunca `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, `CREATE` ni escritura sobre `role_permissions`, `permissions` o `roles`. Es idempotente y reversible, y trae un verificador de solo lectura (`0002-school-catalog-write.verify.sql`) que evalúa conjuntamente los privilegios de tabla y de columna (incluidos `PUBLIC`, `GRANT OPTION` y pertenencia a roles) y falla con una excepción si difieren de lo esperado. **Aplicada en `eta15_dev` el 2026-10-26** con `pnpm db:apply-privileges` (ver abajo); la propuesta conserva su barrera `\quit`, que no se elimina: la ejecución usa el archivo `0002-school-catalog-write.apply.sql`, cuyos cuatro `GRANT` son idénticos a los de la propuesta (lo comprueba una prueba y el propio script). En un entorno donde aún no esté aplicada, cada mutación responde **503 `CATALOG_WRITE_UNAVAILABLE`** con un mensaje genérico y no cambia nada; la API nunca amplía privilegios por su cuenta.

**Habilitación en `eta15_dev` (hecha el 2026-10-26; autorizada explícitamente) y reproducción en otros entornos**

1. Preflight de solo lectura: destino 127.0.0.1:5432 / `eta15_dev` / `eta15_app` / PostgreSQL 18; 6 migraciones; 0 usuarios, sesiones, tokens, ciclos y grupos; 42 `role_permissions`; sin objetos extra, propietarios correctos, `eta15_api` solo con la matriz de `roles-postgresql.md`; SHA-256 de los SQL que se aplican.
2. Respaldo nuevo `pg_dump -Fc` fuera del repo, `pg_restore --list` correcto, SHA-256 y resumen no sensible del estado previo (Respaldo previo: `C:\Users\asahe\Backups\ETA15\eta15_dev_pre-0006-0002_20261026-183557.dump` (84 768 bytes, SHA-256 `8190E18E08796877E10EA453240641C38EEC5330A5442945B0B6CEB8B69374AF`, `pg_restore --list` correcto) y resumen no sensible `…summary.txt` junto a él.).
3. `pnpm db:check` y `pnpm db:migrate` (envoltorio protegido): aplicó **solo 0006**. Verificado: 7 migraciones; `catalog:manage_school` solo en `direccion`; `catalog:read` solo en `direccion`; 6 eventos `role.permissions_changed`; 0 usuarios; sin deriva de esquema.
4. Privilegios: `pnpm db:apply-privileges 0002-school-catalog-write --sha256=<hash del .apply.sql revisado>` (**ensayo** con `ROLLBACK`) y después el mismo comando con `--execute`. Ejecuta, en **una sola transacción**, el preflight, los cuatro `GRANT` aprobados y el verificador; solo hace `COMMIT` con `--execute`. Solo admite `127.0.0.1:5432` / `eta15_dev` / `eta15_app` y los archivos de la lista blanca.
5. Verificación posterior como `eta15_api`: `INSERT`/`UPDATE` por columnas aprobadas funcionan (con `ROLLBACK`, sin datos persistentes); `DELETE`, `TRUNCATE`, `TRIGGER`, `REFERENCES`, `CREATE`, `SET ROLE eta15_app`, escritura de `role_permissions`/`permissions`, `id`/`is_active` en el alta y `grade`/`school_year_id` en `UPDATE` dan `42501`.
6. **Otro entorno**: repetir los pasos 1–5 con su propio respaldo (migraciones antes que privilegios; la ejecución se detiene si falta 0006). Falta, para usar el catálogo: ratificar D-CAT y hacer el bootstrap escolar (D-ESC, bloqueado).

**Interfaz** (`/catalogo`, enlace "Catálogo escolar" solo con `catalog:read`): pestañas "Ciclos escolares" y "Grupos"; filtros por ciclo (el vigente por defecto), grado, turno (incluye "sin turno"), estado y búsqueda de código; paginación; formularios con validación previa y errores por campo (el foco pasa al primer campo inválido y visible); confirmación para activar/desactivar; configuración de la hora de entrada por grupo (y opción de quitarla); los controles de escritura solo aparecen con `catalog:manage_school` (Dirección) y el servidor vuelve a autorizar todo. Sin tablero complejo, alumnos ni asistencia.

**Pruebas**: contratos y servicio (validación, relevo de ciclos con "hoy" inyectado), HTTP en PGlite y en un clúster PostgreSQL 18 desechable (con y sin la propuesta 0002; incluye privilegios reales por SQL directo y 10 activaciones/altas simultáneas), 30 pruebas de componentes con `fetch` falso y una pasada manual en el navegador integrado (127.0.0.1:5173) contra `pnpm dev:sandbox -- --catalog-write`, con Dirección ficticia: crear ciclo, traslape rechazado, activar, crear grupos con horarios 07:00 y 07:50, duplicado rechazado, editar y quitar horario, desactivar, foco en errores y móvil de 375 px; prefectura (sin acceso) y admin_tecnico (solo lectura) comprobados también por API (403). `--catalog-write` aplica la propuesta 0002 **solo en el clúster desechable**.

## Constraints y por qué existen

| Constraint                                           | Razón                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `school_years_dates_ordered`                         | Un ciclo termina después de empezar                                                                                                                                                                                                                |
| `school_years_no_overlap` (EXCLUDE gist, 0001)       | Sin traslape; `daterange(starts_on, ends_on, '[]')` + `&&` nativo, **sin extensiones**                                                                                                                                                             |
| `school_years_name_key`, `_name_not_blank`           | Nombre único y limpio                                                                                                                                                                                                                              |
| `school_years_single_active_idx` (parcial)           | A lo más un ciclo vigente                                                                                                                                                                                                                          |
| `groups_year_grade_code_shift_key`                   | Sin duplicados. `NULLS NOT DISTINCT` (PG ≥ 15) trata el turno `NULL` como valor                                                                                                                                                                    |
| `groups_code_length`, `groups_code_format`           | Forma canónica del identificador                                                                                                                                                                                                                   |
| `groups_grade_range`, `groups_shift_values`          | Valores válidos (`NULL` pasa el check de turno)                                                                                                                                                                                                    |
| `groups_expected_entry_time_range`, `_minute` (0002) | Rechazan `24:00:00` y segundos distintos de 0; `NULL` permitido                                                                                                                                                                                    |
| `groups_school_year_id_fkey` RESTRICT                | Integridad referencial e histórico                                                                                                                                                                                                                 |
| `groups_id_school_year_id_key`                       | Habilita la FK compuesta `(group_id, school_year_id)` desde matrículas                                                                                                                                                                             |
| trigger `set_updated_at` (0001)                      | `updated_at` confiable en servidor para sincronización por delta. Es una sola función pequeña, `SECURITY INVOKER`, con `search_path = pg_catalog, pg_temp`. Se prefiere al `$onUpdate` de la app porque cubre también SQL directo y otros clientes |

## Índices y consultas habituales

- Ciclo vigente: lo resuelve `school_years_single_active_idx` (parcial).
- Cruce de fechas ("¿a qué ciclo pertenece esta fecha?"): lo sirve el índice gist de `school_years_no_overlap`.
- Grupos de un ciclo (y por grado): prefijo de `groups_year_grade_code_shift_key`. No hay índice extra en `school_year_id`.
- Tablas pequeñas (decenas de filas): no se añaden más índices; `updated_at` se indexará cuando exista el endpoint de sincronización con volumen que lo justifique.

## Extensión futura (no implementado)

| Entidad futura              | Relación y razón                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `students`                  | Datos de la persona. **Sin `group_id`**: el grupo no es atributo del alumno, es un hecho histórico.                                                                                                                                                                                                                                                    |
| `enrollments`               | `student_id`, `school_year_id`, `group_id`, `starts_on`, `ends_on` NULL. FK compuesta `(group_id, school_year_id)` → `groups(id, school_year_id)`. Un cambio de grupo cierra una matrícula y abre otra; sin matrículas traslapadas del mismo alumno en el mismo ciclo (EXCLUDE por `student_id`, que sí requerirá `btree_gist`: se evaluará entonces). |
| `prefect_group_assignments` | `prefect_user_id`, `group_id`, `starts_on`, `ends_on` NULL. Cambia con el tiempo; las listas pasadas se interpretan con la asignación vigente ese día.                                                                                                                                                                                                 |
| `attendance_days`           | Un registro por grupo y fecha (`UNIQUE(group_id, date)`), con quién y cuándo lo capturó.                                                                                                                                                                                                                                                               |
| `attendance_records`        | Un renglón por alumno y día (`attendance_day_id`, `enrollment_id`), ligado a la **matrícula** para respetar el grupo de ese día. `UNIQUE(attendance_day_id, enrollment_id)`.                                                                                                                                                                           |

## Sincronización offline

UUID v7 generables en cliente y ordenados en el tiempo; `updated_at` por trigger como cursor de cambios; sin DELETE (la baja es una actualización).

## Migraciones

- `0000_school_catalog.sql`: tablas, FK, checks, uniques e índice parcial. Sin `DROP`/`TRUNCATE`.
- `0001_school_catalog_integrity.sql`: `EXCLUDE` de traslape, función y triggers `set_updated_at`. Manual porque Drizzle no los expresa.
- `0002_group_expected_entry_time.sql` (generada con el envoltorio protegido y **aplicada**; commit `1cd551a`): `ALTER TABLE groups ADD COLUMN expected_entry_time time(0)` + dos `CHECK` (`< TIME '24:00:00'` y `EXTRACT(SECOND FROM ...) = 0`). No destructiva; las migraciones 0000 y 0001 no se modificaron. Probada en PGlite como migración incremental sobre grupos ya existentes (`test/school-catalog.entry-time.migration.test.ts`).
- **Journal** (ahora con 3 entradas, `0000`–`0002`): `meta/_journal.json` registra `idx 0`, `1` y `2` con marcas `when` crecientes (el migrador omite una migración cuya marca no supere la última aplicada). Verificado con `readMigrationFiles` (el mismo lector que usa el migrador de Drizzle: encuentra las tres, en orden, con hash distinto), `drizzle-kit check` ("Everything's fine") y `generate` ("No schema changes"). `drizzle.__drizzle_migrations` en `eta15_dev` registra las 3 (id 1–3).

## Aplicación real en `eta15_dev`

### Migración 0002 (2026-10-25, tras el commit `1cd551a`)

- **Preflight** (solo lectura): destino 127.0.0.1:5432 / `eta15_dev` / `eta15_app`; `server_version_num` 180000; tablas `groups` y `school_years` (0 filas); 2 migraciones registradas; la columna y sus constraints no existían.
- **Respaldo**: `C:\Users\asahe\Backups\ETA15\eta15_dev_pre-0002_20261025-235720.dump` (9801 bytes), `pg_dump` y `pg_restore --list` con código 0, SHA-256 `BD1D88D8765818F10E1B5EE1896D3C7F3DD8DEC7D77C7AF1942765D1E3C32E91`. El respaldo anterior se conservó. No se restauró.
- **Aplicación**: `pnpm db:migrate` (envoltorio protegido → `drizzle-kit migrate`), solo la 0002 estaba pendiente.
- **Verificado en PG 18 real**: columna `time without time zone`, precisión 0, nullable; constraints `groups_expected_entry_time_range` y `_minute` presentes y el resto de las de `groups` y `school_years` intactas; triggers y función sin cambios; sin tablas nuevas. Comportamiento (datos ficticios, `BEGIN … ROLLBACK`): `NULL`, 07:00, 07:50, 13:05, 00:00 y 23:59 aceptadas; `07:00:30`, `07:50:01` y `24:00:00` rechazadas (`23514`), `25:00` rechazada (`22008`), también en `UPDATE`; unicidad, formato de `code`, grado, ciclo vigente único, traslape, FK y `RESTRICT` siguen funcionando; el trigger impone `updated_at = now()` al cambiar la hora. Tras el `ROLLBACK`: 0 filas en ambas tablas.
- **Límite**: `eta15_dev` no tenía grupos al migrar, así que "los grupos existentes conservan su valor `NULL`" se probó solo en PGlite (migración incremental con filas previas), no en el servicio real.
- _Notas_: dos comprobaciones fallaron por errores de **mi script de prueba** (comparación de `inet` con máscara `/32` en el preflight, y una prueba de `updated_at` que ignoraba que `now()` es constante dentro de una transacción); se corrigieron y repitieron sin tocar la base.

### Migraciones 0000 y 0001

- **Fecha**: 2026-10-25. Servidor: PostgreSQL 18.0 (x86_64-windows), `127.0.0.1:5432`, base `eta15_dev`, rol `eta15_app` (sin privilegios administrativos).
- **Preflight** (solo lectura): destino correcto; sin tablas, funciones, triggers ni esquema `drizzle`; única extensión `plpgsql`.
- **Respaldo previo** (`pg_dump -Fc`, PG 18.0): `C:\Users\asahe\Backups\ETA15\eta15_dev_pre-catalogo_20261025-233739.dump`, 1053 bytes (la base estaba vacía), `pg_restore --list` correcto, SHA-256 `3E3C67A5698B8AFD63F27756DA202B4CE658DE3D85CB1016FA4C0417E5401251`. No se restauró.
- **Ejecución**: `drizzle-kit migrate` (sin `push`): "migrations applied successfully". `drizzle.__drizzle_migrations` registra 2 filas (id 1 y 2), en el orden 0000 → 0001.
- **Verificado en PG 18 real** (consultas de catálogo): 2 tablas con propietario `eta15_app`; `uuidv7()` por defecto en ambos `id`; PK, 2 UNIQUE y 1 FK `RESTRICT/RESTRICT`; checks de fechas, nombre, grado, `code` (longitud y formato) y turno; `UNIQUE NULLS NOT DISTINCT`; `EXCLUDE USING gist` con índice gist; índice único parcial de ciclo vigente; triggers `BEFORE UPDATE` en ambas tablas; `set_updated_at` con `search_path = pg_catalog, pg_temp` y sin `SECURITY DEFINER`; sin extensiones nuevas.
- **Verificado en PG 18 real** (comportamiento, datos ficticios en una transacción con `ROLLBACK`): 35 comprobaciones correctas tras repetir las 2 mal planteadas (ver nota) — traslapes inclusivos (inicio=fin ajeno, fin=inicio ajeno, contenido, envolvente), consecutivo válido, dos ciclos vigentes rechazados, ciclos futuros inactivos permitidos, duplicados con turno `NULL`/matutino rechazados mientras `NULL`, matutino y vespertino coexisten, `code` no normalizado/acentos/11 caracteres/vacío rechazados, grado 0 y 4, turno desconocido, ciclo inexistente (`23503`), `RESTRICT` (`23001`), UUID v7, `updated_at`. Tras el `ROLLBACK`: `school_years = 0`, `groups = 0`.
- _Nota_: una primera ejecución marcó 2 FAIL por errores de **mi script de prueba** (esperaba `23503` en lugar de `23001` para `RESTRICT`, y fijaba `updated_at` con un `UPDATE` que ya activaba el trigger). Se corrigieron y repitieron; la base se comportó correctamente.
- Solo se conectó a `eta15_dev`; no se tocaron `beauty_pos`, `postgres`, roles, `pg_hba.conf`, `postgresql.conf` ni el firewall.

## Validación y límites

- **Hecho**: las migraciones se aplican, vía el lector del migrador, sobre **PGlite 0.5.11 = PostgreSQL 18.6 en WASM** (`test/school-catalog.migration.test.ts`): `uuidv7()` nativo (la prueba falla si no lo es), constraints, traslapes inclusivos, vigencia única, duplicados con turno `NULL`, normalización, FK, `updated_at`.
  _Corrección_: una versión anterior de esta documentación decía "PG 17 con `uuidv7` simulado"; era incorrecto.
- **Distinción**: las pruebas de `test/school-catalog.migration.test.ts` corren en **PGlite (memoria, PG 18.6 WASM)**; las verificaciones de la sección anterior corren en el **servicio real PostgreSQL 18.0**. Ambas coinciden.
- **Sigue sin probarse**: concurrencia real entre sesiones (p. ej. dos transacciones activando ciclos a la vez; el índice único lo impediría, pero no se simuló), rendimiento con volumen y comportamiento con otra collation/encoding de servidor (las reglas usan solo ASCII a propósito).
- Validadores de entrada (Zod): `src/modules/school-catalog/school-catalog.schemas.ts`.

## Pendientes y riesgos

- Confirmar con dirección: turno `NULL` mezclado con turnos nombrados en el mismo grado/código; grados 1–3 fijos; ciclo vigente único.
- La contraseña local de `eta15_app` es corta (5 caracteres): cambiarla por una robusta (`\password eta15_app` y `tools\set-db-password.ps1`).
- Las migraciones solo existen en `eta15_dev`; no hay procedimiento de aplicación en otros entornos todavía.
- En producción las migraciones las aplicará un rol propietario distinto del rol de la API (ADR 0003).
- Endpoints y UI del catálogo implementados e integrados; 0006 y 0002 aplicadas en `eta15_dev`. Pendientes: ratificar D-CAT, el bootstrap escolar (D-ESC) y **no usar datos reales** hasta entonces.
- Reglas con impacto funcional: (a) un ciclo futuro no puede activarse antes de su fecha de inicio, así que entre ciclos (p. ej. vacaciones) puede no haber ciclo vigente; el vigente que ya terminó sigue marcado hasta que Dirección lo desactive o active el siguiente; (b) corregir el grado o el ciclo de un grupo exige desactivarlo y crear otro; (c) un cambio de horario no conserva historial (ver snapshot en eventos de acceso).
- La API no cambia `school_year_id` ni `grade` de un grupo, y con 0002 aplicada tampoco el rol de la API podría; `eta15_app` (propietario) sí, por diseño.

## Comandos

```powershell
. .\tools\env.ps1
pnpm --filter @eta15/api exec drizzle-kit generate   # genera desde el esquema (no toca la BD)
pnpm --filter @eta15/api exec drizzle-kit check      # consistencia del historial
pnpm test                                            # validadores + migraciones en memoria (PG 18.6)
pnpm typecheck; pnpm lint; pnpm build; pnpm format:check
```
