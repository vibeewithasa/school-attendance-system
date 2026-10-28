# Reportes básicos de asistencia (MVP administrativo — Fase 1)

Rama `feat/attendance-basic-reports` (apilada sobre `feat/android-manual-sync-sandbox`; Draft PR sin fusionar). **Solo lectura.** Sin
migraciones, sin `GRANT` nuevos, sin cambios en `eta15_dev`, en Android ni en el canal móvil. Sin datos reales.

## 1. Qué hay y qué no

| Hay                                                                                               | No hay (deliberadamente)                                                        |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Reporte **por grupo**: ciclo, grupo autorizado y periodo; lista por día hábil y marcas por alumno | Justificantes (decisión **D-10** pendiente de la escuela), alertas ni umbrales  |
| Reporte **por alumno**: marca o motivo de que no la haya, por día hábil; grupos históricos        | Porcentajes, promedios, «asistencia oficial», semáforos o estadísticas          |
| Selectores de ciclo, grupo y alumno limitados al alcance de la cuenta                             | CSV, Excel, PDF, impresión, correo ni envío a terceros                          |
| Pantallas en el portal (`/asistencia/reportes/grupo` y `/asistencia/reportes/alumno`)             | Calendario escolar, días festivos o suspensiones (no se conocen ni se inventan) |
| Avisos visibles de limitaciones junto a cada resultado                                            | Correcciones, capturas históricas o cualquier escritura                         |

## 2. Semántica (lo que cada cosa significa)

Fuente única de marcas: **`attendance_records`** (canónica) unida a la cabecera `attendance_days`. El historial
`attendance_events` **no se consulta jamás**: por eso los recibos de idempotencia (`mark_changed` con `old = new`) y cualquier otro
evento no pueden contarse como marcas ni cambiar un total.

| Situación                       | Qué es                                                                                           | ¿Es ausencia?  |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | -------------- |
| **Presente / Ausente**          | Marca registrada en una lista (finalizada o en borrador)                                         | Solo «Ausente» |
| **Sin marca**                   | Renglón pendiente (`status` NULL) de una lista en **borrador**; una finalizada no puede tenerlo  | **No**         |
| **Sin lista**                   | No existe lista del grupo ese día hábil: «no determinado» (no se sabe si hubo clase)             | **No**         |
| **No estaba en el padrón**      | La lista existe, pero el alumno no está en su padrón congelado (se incorporó después de abrirla) | **No**         |
| **Sin grupo ese día**           | Sin inscripción vigente o sin grupo (dentro del alcance de quien consulta) ese día               | **No**         |
| Lista **borrador / finalizada** | Estado de la lista (`attendance_days.status`)                                                    | —              |

- Solo cuentan **días hábiles (lunes a viernes)**; sábado y domingo no son días del reporte ni ausencias (la base ya impide listas
  en fin de semana). No se conocen festivos ni suspensiones: un día hábil sin lista queda «sin lista», nunca se infiere una ausencia.
- **No se atribuye asistencia de un grupo al que el alumno no pertenecía.** El reporte por alumno parte de sus renglones
  (`attendance_records`, que ligan la lista y la asignación de grupo histórica) y de sus asignaciones; un traslado se refleja día a día.
- **No hay justificantes** (D-10): ningún total se ajusta; la ausencia sigue siendo ausencia. El texto está **siempre visible** en
  ambas pantallas (`ReportLimits`). Cuando la escuela decida D-10, el módulo de justificantes deberá definir cómo se muestran las
  faltas justificadas; estos reportes **no** lo anticipan.
- Totales verificables (probados): `presentes + ausentes + sin marca = registros alumno-día`; `días con lista + días sin lista =
días hábiles`; la suma por alumno coincide con el total del grupo; y lo que dice el reporte por alumno coincide con su renglón en el
  del grupo.

## 3. Endpoints (todos `GET`, bajo `/school/attendance/reports`)

Todos exigen sesión y la puerta de MFA (`adminGuard`), tienen límite de peticiones, validan con Zod **estricto** (parámetros
desconocidos o repetidos → 400 sin repetir la entrada) y responden `Cache-Control: no-store`. **No escriben** (ni auditoría de
lectura); las denegaciones (403) sí quedan en `authz.denied`. El canal móvil (`/mobile/*`) **no** expone reportes.

| Ruta                                           | Qué devuelve                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /options`                                 | Ciclos y grupos que la cuenta puede consultar (con `schoolToday`, el «hoy» del servidor). |
| `GET /group/:groupId/students`                 | Alumnos que alguna vez estuvieron asignados al grupo en su ciclo (id y nombre).           |
| `GET /group?groupId&from&to[&schoolYearId]`    | Reporte por grupo: `days[]` (lista o `null`), `students[]` y `totals`.                    |
| `GET /student/:studentId?schoolYearId&from&to` | Reporte por alumno: `student`, `enrollment`, `groups[]`, `days[]` (`state`) y `totals`.   |

Contratos: `packages/shared-contracts/src/attendance-reports.ts` (`AttendanceGroupReport`, `AttendanceStudentReport`,
`StudentReportState` = `present | absent | no_mark | no_list | not_in_roster | not_in_group`, etc.). Implementación:
`apps/api/src/modules/attendance/attendance.reports.ts` (consultas puras) y los métodos `report*` de `attendance.service.ts`.

### Fechas y límites

- Fechas ISO (`YYYY-MM-DD`) de calendario de la escuela (`America/Mazatlan`), periodo **inclusivo**. Malformadas o inexistentes
  (p. ej. `2026-02-30`), faltantes, `from > to` o más de **190 días naturales** → `400 VALIDATION_ERROR`.
- Fuera del ciclo del grupo/alumno → `400 RANGE_OUT_OF_YEAR`; con fecha posterior al «hoy» del servidor → `400 RANGE_IN_FUTURE`.
  Estas dos comprobaciones ocurren **después** de autorizar: quien no tiene acceso recibe 404, no un 400 que confirme el recurso.
- Tamaño acotado: a lo sumo 136 días hábiles por respuesta y un renglón por alumno del padrón; por eso no hay paginación (el
  listado de listas, que sí crece, conserva la suya). El orden es determinista (fecha; apellidos, nombres, id).
- Un periodo de solo fin de semana devuelve `days: []` y totales en cero (no es un error).

## 4. Permisos y privacidad

- **Un solo permiso**: `attendance:read`, con su alcance. No se creó ningún permiso nuevo ni se amplió el de ningún rol. Dirección
  (`all`) consulta todo; prefectura (`assigned_groups`) solo los grupos con **asignación vigente hoy**; `trabajo_social`,
  `control_acceso` y `admin_tecnico` no tienen el permiso (403 + auditoría).
- El alcance se aplica **en la consulta** (`group_id = ANY(...)`). Fuera de alcance == inexistente (404 con el mismo código y mensaje:
  grupo ajeno, id inexistente, ciclo equivocado, alumno de otro grupo o sin matrícula en el ciclo).
- **Alumno visto por prefectura**: solo si tuvo asignación a uno de sus grupos en ese ciclo; y solo se muestran los renglones, días y
  grupos de **sus** grupos. Los días en que estuvo en otro grupo salen como «sin grupo ese día» (no se filtra ni el grupo ni la
  asistencia ajena). El código escolar solo lo ve el alcance total (Dirección). Sin CURP, tutores, fotografía ni datos médicos.
- Las consultas están parametrizadas; no hay SQL dinámico con entrada del usuario. Los registros no contienen nombres de menores
  (probado). Los nombres solo viajan en la respuesta autorizada.
- `eta15_api` **no necesita privilegios nuevos**: solo `SELECT` sobre tablas que la asistencia ya lee (probado en PostgreSQL desechable,
  que además verifica que sigue sin poder `DELETE`/`TRUNCATE`). `eta15_dev` no se modificó.
- **Límite conocido**: la prefectura solo ve ciclos y grupos con asignación **vigente hoy**; el historial de asignaciones ya revocadas
  o cerradas no le da acceso a reportes pasados (decisión de seguridad conservadora; Dirección sí los ve). Si la escuela quiere que una
  prefecta consulte sus reportes de un grupo que dejó de atender, requiere una decisión y una revisión de seguridad propias.

## 5. Consistencia y concurrencia

Cada reporte lee dentro de **una sola transacción `REPEATABLE READ`** (el mismo patrón de `GET /days/:id`): las consultas de la
cabecera de listas y de los renglones por alumno ven la misma foto, sin bloquear ni ser bloqueadas. Se probó de forma
**determinista** contra PostgreSQL 18 desechable: un guardado confirmado _justo entre_ ambas consultas no se mezcla en la respuesta
(la prueba **falla** si se desactiva la foto), y lecturas simultáneas a guardados devuelven totales internamente consistentes. Un
guardado posterior sí se ve en la lectura siguiente.

## 6. Interfaz (portal web)

- Entrada «Reportes de asistencia» en la navegación (solo con `attendance:read`) y enlace desde la página de Asistencia; pestañas
  «Reporte por grupo» / «Reporte por alumno». Colores tinto/blanco, componentes y estilos existentes; sin dependencias nuevas.
- Filtros: ciclo (predeterminado el que contiene hoy), grupo, alumno (se cargan al elegir el grupo) y periodo (predeterminado: últimos
  30 días dentro del ciclo y sin pasar de hoy). Se valida en pantalla (el servidor repite todo). Cambiar ciclo, grupo o fechas
  descarta el resultado anterior y **una respuesta tardía de una selección anterior no lo sustituye**.
- Estados: cargando, error (con reintento), acceso denegado, sin grupos, sin alumnos, sin días hábiles, sin listas. Tablas con
  `caption`, `th scope`, etiquetas asociadas, `aria-invalid`/`aria-describedby`, regiones con nombre y avisos con `role="alert"`.
- Desde el reporte por grupo, cada alumno enlaza al reporte individual con el ciclo, grupo y periodo ya elegidos.

## 7. Pruebas

- **API sobre PGlite** (`test/attendance-reports-http.test.ts`, 27): protección (401/403/404/400), cabeceras, parámetros manipulados,
  semántica completa (sin lista, borrador, finalizada, presente, ausente, sin marca, fuera del padrón, traslado, incorporación tardía,
  fin de semana, rangos), alcance parcial por prefectura, determinismo, **sin escrituras** y que un guardado sin cambios (recibo
  `old = new`) no altera ningún conteo mientras un cambio real sí.
- **PostgreSQL 18 desechable con `eta15_api`** (`test/pgtemp/attendance-reports.pg.test.ts`, 29 = la misma suite + privilegios y
  consistencia con conexiones reales, `pnpm test:pg-temp`).
- **Componentes web** (`reportes-asistencia.test.tsx`, 35; jsdom + `fetch` falso): **no son E2E ni pruebas de navegador real**.

## 8. Qué falta / dependencias

- **D-10** (justificantes y reportes) sigue pendiente; hasta entonces los reportes solo muestran marcas registradas.
- Exportaciones, estadísticas, alertas, calendario escolar y reportes de periodos largos (varios meses por consulta) son trabajo
  posterior y dependen de decisiones de la escuela.
- Los datos de `eta15_dev` siguen sin alumnos ni listas: estos reportes se probaron solo con datos sintéticos.
