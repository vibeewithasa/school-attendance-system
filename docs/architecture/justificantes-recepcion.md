# Registro de recepción de justificantes (Trabajo Social — MVP)

Rama `feat/social-work-justifications` (apilada sobre `feat/attendance-basic-reports`, PR #9; Draft PR sin fusionar). **Registra únicamente un
hecho administrativo: «se recibió un justificante».** No aprueba, no rechaza, no justifica faltas, no toca la asistencia ni los reportes y
no genera alertas. La decisión institucional **D-10** (cómo afectan los justificantes a faltas, reportes y alertas) sigue **PENDIENTE**.
ADR 0005 y 0006 siguen PROPUESTOS. **La migración 0013 y la propuesta de privilegios 0007 NO están aplicadas en `eta15_dev`** (se probaron con
PGlite y PostgreSQL 18 desechable). Sin datos reales.

## 1. Qué es y qué no es

| Es                                                                                       | No es (no existe y no se implementó)                                   |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Constancia de que Trabajo Social recibió un documento del alumno X para el día escolar D | Una aprobación, un rechazo o una «falta justificada»                   |
| Folio administrativo (`JR-000001`), quién lo recibió y cuándo (hora del servidor)        | Un cambio en `attendance_records`, listas, revisiones o reportes       |
| Búsqueda mínima del alumno, consulta paginada y filtros por alumno y fecha escolar       | Alertas, notificaciones, correcciones retroactivas, edición o borrado  |
| Auditoría y privacidad (sin motivos, sin diagnósticos, sin adjuntos)                     | Documentos adjuntos, fotografías, PDF, motivos, texto libre o contacto |

La pantalla lo dice siempre: _«El registro de recepción no modifica la asistencia ni acredita la justificación de una falta.»_ y nunca
muestra «falta justificada», «justificante aprobado» ni «ausencia eliminada» (probado).

## 2. Modelo de datos (migración `0013_justification_receipts`)

Tabla `justification_receipts` (schema `apps/api/src/db/schema/justifications.ts`):

| Columna                        | Contenido                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `id`                           | UUID v7.                                                                                                       |
| `folio_number` / `folio`       | Consecutivo global (identidad `ALWAYS`) y folio `JR-` + ≥6 dígitos; los fija la base (trigger), no el cliente. |
| `student_id`, `school_year_id` | FK compuesta a `enrollments(student_id, school_year_id)`: el alumno tenía matrícula en ese ciclo.              |
| `school_date`                  | Día escolar al que se refiere (lunes a viernes). Distinto de la hora de recepción.                             |
| `status`                       | Único valor técnico `received` (CHECK). No existen `approved`/`rejected`.                                      |
| `received_by`, `received_at`   | Quién (la cuenta autenticada) y cuándo (`now()` de la base; un trigger lo impone incluso al propietario).      |
| `request_id`, `payload_hash`   | Idempotencia (ver §5): UUID del cliente y SHA-256 de alumno + fecha.                                           |

Decisiones de diseño:

- **Independiente de la asistencia**: ninguna FK ni columna a `attendance_*` (probado: las únicas FK son `enrollments` y `users`). Un
  justificante puede recibirse para un día sin lista, para un alumno que no faltó o para uno que ya causó baja (si la fecha cae dentro de
  su matrícula).
- **No se copia el grupo.** No se guarda el «grupo actual» como si fuera el histórico: el grupo de ese día se deduce de
  `student_group_assignments` por fecha cuando haga falta. La búsqueda muestra el grupo actual **solo para distinguir homónimos** y no se
  almacena.
- **Sin `UNIQUE alumno + fecha`**: pueden recibirse varios documentos del mismo día (probado). Solo `(received_by, request_id)` es único.
- **Inmutable y sin borrado físico**: triggers `jr_no_update`, `jr_no_delete` y `jr_no_truncate` (también para el propietario). Corregir
  un error de captura (anular, editar) es una decisión institucional pendiente y no existe.
- **Fecha escolar válida** (CHECK + trigger + servicio): lunes a viernes, **no futura** (hoy en `America/Mazatlan`) y dentro del periodo
  de la matrícula del alumno. _Provisional_: no hay política aprobada sobre justificantes anticipados; se eligió lo conservador y se puede
  relajar. No se conocen festivos.
- **Datos no almacenados**: motivo, diagnóstico, descripción, adjuntos, fotografías, PDF, documentos de identidad, contacto, tutores y
  cualquier texto libre. Si la escuela decide que se necesita alguno, es una decisión nueva (y de privacidad) antes de agregarlo.

## 3. Permisos y alcance

| Permiso                                   | Quién                                  | Qué permite                                |
| ----------------------------------------- | -------------------------------------- | ------------------------------------------ |
| `justifications:create` (**nuevo**, 0013) | `trabajo_social` (`all`)               | Registrar la recepción y buscar al alumno. |
| `justifications:read` (existente)         | `trabajo_social` y `direccion` (`all`) | Consultar registros (y buscar al alumno).  |

- Solo cuenta el alcance **`all`**. La prefectura conserva su concesión histórica `justifications:read` con `assigned_groups` (semilla
  0004; no se modificó), pero **el módulo no la acepta**: 403 en todas las rutas (probado, aunque tenga `attendance:read`).
  `control_acceso` y `admin_tecnico`: 403. Sin sesión, con cookie inválida, sesión caducada o cuenta deshabilitada: 401.
- Dirección consulta pero **no registra** (403). No se concedió ningún permiso a prefectura ni a otros roles.
- **Búsqueda de alumno**: Trabajo Social no tiene `students:*` (política cerrada 0008), así que el módulo ofrece una búsqueda **mínima**
  propia: id, nombre, código escolar y grupo actual (solo para distinguir homónimos); mínimo 3 letras, máximo 20 resultados, con marca de
  recorte. Es una exposición nueva de nombres de menores a Trabajo Social bajo `justifications:*` y queda como **propuesta técnica
  pendiente de ratificación institucional**; su auditoría registra solo el conteo, nunca el texto buscado.
- Alumno «autorizado»: con alcance `all`, cualquier alumno con alguna matrícula; el registro exige además matrícula vigente en la fecha.

## 4. API (`/school/justifications`, solo portal web)

Sesión + MFA (`adminGuard`), CSRF y Origin en la creación, límite de peticiones, Zod **estricto** (campos desconocidos como `receivedAt`,
`receivedBy`, `folio`, `status` o `reason` → 400 sin repetir la entrada) y `Cache-Control: no-store`. No hay rutas para aprobar, rechazar,
editar ni eliminar (probado 404/405). El canal móvil no las expone.

| Ruta                | Qué hace                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /students?q=`  | Búsqueda mínima de alumno (3–100 caracteres).                                                                     |
| `POST /receipts`    | `{requestId, studentId, schoolDate}` → 201 `{receipt, replayed:false}`; reintento idéntico → 200 `replayed:true`. |
| `GET /receipts`     | Paginada (`page`, `pageSize` ≤ 50), más reciente primero; filtros `studentId`, `from`, `to` (fecha escolar).      |
| `GET /receipts/:id` | Un registro (la consulta individual se audita).                                                                   |

Errores de negocio (`error.code`): `NOT_SCHOOL_DAY`, `DATE_IN_FUTURE`, `NOT_ENROLLED_ON_DATE` (400), `STUDENT_NOT_FOUND` (404),
`IDEMPOTENCY_MISMATCH` (409), `JUSTIFICATIONS_UNAVAILABLE` / `DATABASE_UNAVAILABLE` (503). Los 5xx no exponen detalles internos.
Contratos: `packages/shared-contracts/src/justifications.ts`. Implementación: `apps/api/src/modules/justifications/`.

## 5. Idempotencia

El cliente genera un `requestId` (UUID) por envío. `UNIQUE (received_by, request_id)` + `payload_hash`:

- Mismo `requestId` y mismo contenido (reintento, doble clic, envío simultáneo): **el mismo registro** (200, `replayed`), sin segundo
  folio ni segunda auditoría. `INSERT … ON CONFLICT DO NOTHING` resuelve la carrera entre conexiones (probado con 20 envíos simultáneos
  contra PostgreSQL real: 1 registro).
- Mismo `requestId` con otro alumno o fecha: **409** `IDEMPOTENCY_MISMATCH`, auditado y sin registro nuevo.
- La clave es **por persona**: el mismo `requestId` de otra cuenta se trata como otra solicitud (no se filtra que existe).
- La interfaz conserva la clave en los reintentos tras un fallo de red y la renueva tras un éxito (un segundo documento es otro registro).

## 6. Auditoría

En la **misma transacción** que el registro (si la auditoría falla, no queda registro; probado). Eventos (`audit_events`):
`justification.receipt_registered` (actor, `receiptId`, folio, `studentId`, `schoolDate`, `requestId`), `justification.idempotency_mismatch`
(fallo), `justification.receipt_viewed`, `justification.students_searched` (solo `resultCount` y `truncated`) y `authz.denied`. Nunca
nombres de menores, tokens, cookies, contraseñas ni datos médicos (no se capturan). Un reintento idéntico no genera evento nuevo.

## 7. Interfaz (portal web)

«Justificantes» en el menú (solo con alcance `all` de `justifications:read` o `create`). Búsqueda de alumno, fecha escolar, registro con
confirmación y folio, e historial paginado con filtros por alumno y rango de fecha escolar; estados de carga, error con reintento, sin
resultados, sin permisos y guardado en curso (el botón se deshabilita: no hay doble envío). Colores tinto/blanco, etiquetas asociadas,
`aria-invalid`/`aria-describedby`, tablas con `caption` y `th scope`. Dirección ve el historial sin el formulario.

## 8. Privilegios y despliegue

- Migración **0013** (tabla, triggers, permiso `justifications:create` para `trabajo_social`) — **no aplicada** en `eta15_dev`
  (pendientes localmente: 0011, 0012 y 0013).
- Propuesta **0007** `tools/db/privileges/0007-justifications-write.*`: `SELECT` de todas las columnas e `INSERT` solo de
  `student_id, school_year_id, school_date, received_by, request_id, payload_hash`; sin `UPDATE`, `DELETE`, `TRUNCATE` ni `received_at`,
  `folio`, `status`. Se aplica con `pnpm db:apply-privileges 0007-justifications-write --sha256=…` (ensayo con ROLLBACK por defecto).
  Sin ella el módulo responde 503 controlado (probado).

## 9. Pruebas

- API sobre PGlite (`test/justifications-http.test.ts`, 27) y PostgreSQL 18 desechable con `eta15_api` (`test/pgtemp/justifications.pg.test.ts`,
  suite completa + matriz de privilegios + concurrencia real + modo «sin 0007», 31) y la aplicación controlada de la propuesta 0007
  (`privilege-apply-justifications*.test.ts`).
- Verifican, entre otros: registro válido, alumno inexistente/sin matrícula en la fecha, fechas inválidas, doble clic y reintentos, misma
  clave con otro contenido, varios documentos del mismo día, RBAC por rol, CSRF/Origin, sesión caducada y cuenta deshabilitada, rollback
  y errores de la base sin fugas, y que **la asistencia (listas, renglones, historial) y los reportes quedan idénticos** tras registrar
  justificantes (incluso para el día de una falta, que sigue siendo falta).
- Componentes web (`justificantes.test.tsx`, 27; jsdom + `fetch` falso): **no son E2E ni pruebas de navegador real**.

## 10. Pendiente / dependencias

- **D-10**: qué efecto tienen los justificantes en faltas, reportes y alertas. Hasta entonces no se conectan.
- Anulación/corrección de un registro mal capturado, adjuntos, motivos, notificaciones y políticas de fechas anticipadas o tardías.
- Ratificar la búsqueda mínima de alumnos para Trabajo Social y la retención de estos registros.
- Aplicar 0013 y la propuesta 0007 en `eta15_dev` (con respaldo y autorización) cuando corresponda.
