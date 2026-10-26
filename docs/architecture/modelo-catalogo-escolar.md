# Modelo del catálogo escolar (`school_years`, `groups`)

Estado: **diseño revisado y migraciones generadas; NO aplicadas en `eta15_dev`**. Esquema Drizzle:
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

| Columna                    | Tipo        | Notas                                                                    |
| -------------------------- | ----------- | ------------------------------------------------------------------------ |
| `id`                       | uuid PK     | `uuidv7()`                                                               |
| `school_year_id`           | uuid FK     | `NOT NULL` → `school_years(id)`, `ON DELETE/UPDATE RESTRICT`             |
| `grade`                    | smallint    | 1 a 3                                                                    |
| `code`                     | text        | Identificador del grupo, 1–10 caracteres, **ya normalizado** (ver abajo) |
| `shift`                    | text NULL   | `matutino` / `vespertino`; `NULL` si no se distinguen turnos             |
| `is_active`                | boolean     | Por defecto `true`                                                       |
| `created_at`, `updated_at` | timestamptz | Igual que arriba                                                         |

## Reglas definitivas

1. `school_years` son ciclos académicos con fecha de inicio y de fin.
2. **Sin traslape**, con fechas inclusivas: si un ciclo termina el 15-jul, el siguiente puede empezar el 16-jul, no el 15-jul.
3. **Un solo ciclo vigente** (`is_active`), pero se pueden registrar ciclos futuros inactivos. Para relevar: desactivar el anterior y activar el nuevo en una transacción.
4. Grados **1 a 3**. No se limita la cantidad de grupos.
5. `code` admite hasta **10 caracteres**: letras A–Z (ASCII) y dígitos, con separadores simples (un espacio o un guion) entre bloques. Ejemplos: `A`, `1A`, `TEC-1`, `TEC 2`.
6. **Normalización**: la forma canónica es mayúsculas, sin espacios en los bordes y sin separadores repetidos. La API la aplica (`normalizeGroupCode`: recorta, colapsa espacios, pasa a mayúsculas) y la BD **rechaza** cualquier valor no canónico. Así el `UNIQUE` simple basta para evitar `a` / `A` / ` A`.
7. Turno opcional. Sin duplicados por ciclo + grado + `code` + turno (`NULL` cuenta como un valor: dos grupos sin turno iguales chocan).
8. La pertenencia histórica de alumnos se registrará en `enrollments` (no implementado). No hay materias ni asistencia por clase en el MVP.
9. **Sin borrado físico**: se desactiva (`is_active = false`). Las FK `RESTRICT` impiden borrar un ciclo con grupos; agregar ciclos o grupos nuevos no modifica filas existentes.
10. Un grupo pertenece a su ciclo para siempre. La BD **no** impide cambiar `school_year_id` (impedirlo requeriría otro trigger); la API no debe exponerlo. Las matrículas lo respaldarán con la FK compuesta.

## Constraints y por qué existen

| Constraint                                     | Razón                                                                                                                                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `school_years_dates_ordered`                   | Un ciclo termina después de empezar                                                                                                                                                                                                                |
| `school_years_no_overlap` (EXCLUDE gist, 0001) | Sin traslape; `daterange(starts_on, ends_on, '[]')` + `&&` nativo, **sin extensiones**                                                                                                                                                             |
| `school_years_name_key`, `_name_not_blank`     | Nombre único y limpio                                                                                                                                                                                                                              |
| `school_years_single_active_idx` (parcial)     | A lo más un ciclo vigente                                                                                                                                                                                                                          |
| `groups_year_grade_code_shift_key`             | Sin duplicados. `NULLS NOT DISTINCT` (PG ≥ 15) trata el turno `NULL` como valor                                                                                                                                                                    |
| `groups_code_length`, `groups_code_format`     | Forma canónica del identificador                                                                                                                                                                                                                   |
| `groups_grade_range`, `groups_shift_values`    | Valores válidos (`NULL` pasa el check de turno)                                                                                                                                                                                                    |
| `groups_school_year_id_fkey` RESTRICT          | Integridad referencial e histórico                                                                                                                                                                                                                 |
| `groups_id_school_year_id_key`                 | Habilita la FK compuesta `(group_id, school_year_id)` desde matrículas                                                                                                                                                                             |
| trigger `set_updated_at` (0001)                | `updated_at` confiable en servidor para sincronización por delta. Es una sola función pequeña, `SECURITY INVOKER`, con `search_path = pg_catalog, pg_temp`. Se prefiere al `$onUpdate` de la app porque cubre también SQL directo y otros clientes |

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
- **Journal**: `meta/_journal.json` registra `idx 0` y `idx 1` con marcas `when` crecientes (el migrador omite una migración cuya marca no supere la última aplicada). Verificado con `readMigrationFiles` (el mismo lector que usa el migrador de Drizzle: encuentra ambas, en orden, con hash distinto), `drizzle-kit check` ("Everything's fine") y `drizzle-kit generate` ("No schema changes"). **No se ejecutó `migrate`.**

## Validación y límites

- **Hecho**: las migraciones se aplican, vía el lector del migrador, sobre **PGlite 0.5.11 = PostgreSQL 18.6 en WASM** (`test/school-catalog.migration.test.ts`): `uuidv7()` nativo (la prueba falla si no lo es), constraints, traslapes inclusivos, vigencia única, duplicados con turno `NULL`, normalización, FK, `updated_at`.
  _Corrección_: una versión anterior de esta documentación decía "PG 17 con `uuidv7` simulado"; era incorrecto.
- **No probado (diferencias posibles con el servicio real de Windows)**: collation/locale y encoding del servidor (las reglas usan solo ASCII a propósito), permisos del rol `eta15_app` al ejecutar DDL y crear el trigger/función, extensiones instaladas, concurrencia real entre sesiones y rendimiento. PGlite es de 32 bits y un solo proceso.
- **No hecho**: aplicar en `eta15_dev`. Requiere autorización explícita.
- Validadores de entrada (Zod): `src/modules/school-catalog/school-catalog.schemas.ts`.

## Pendientes y riesgos

- Confirmar con dirección: turno `NULL` mezclado con turnos nombrados en el mismo grado/código; grados 1–3 fijos; ciclo vigente único.
- Aplicar la migración en `eta15_dev` (respaldo previo y verificación de solo lectura posterior).
- En producción las migraciones las aplicará un rol propietario distinto del rol de la API (ADR 0003).
- Sin endpoints ni UI del catálogo.

## Comandos

```powershell
. .\tools\env.ps1
pnpm --filter @eta15/api exec drizzle-kit generate   # genera desde el esquema (no toca la BD)
pnpm --filter @eta15/api exec drizzle-kit check      # consistencia del historial
pnpm test                                            # validadores + migraciones en memoria (PG 18.6)
pnpm typecheck; pnpm lint; pnpm build; pnpm format:check
```
