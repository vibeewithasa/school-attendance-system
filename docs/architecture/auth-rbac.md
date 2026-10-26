# Autenticación y autorización (Auth/RBAC)

Rama: `feat/auth-rbac`. Decisión de arquitectura: [ADR 0004](../decisions/0004-auth-sesiones-servidor-argon2id.md).
Referencia principal: **OWASP ASVS 5.0.0** — V6 (Autenticación), V7 (Sesiones) y V8 (Autorización) — más las hojas de OWASP de almacenamiento de contraseñas (Argon2id ≥ m = 19 MiB, t = 2, p = 1), sesiones y CSRF. La numeración de cada requisito se verifica contra el estándar oficial en la etapa 9; aquí se cita por capítulo.

## 1. Estado real: qué existe y qué no

| Elemento                                                                                                       | Estado                                                                                             |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Esquema de 8 tablas y migraciones `0003` (esquema), `0004` (semilla), `0005` (integridad)                      | **Hechos y APLICADOS en `eta15_dev` (2026-10-26, commit `df82d6d`)**; ver `roles-postgresql.md`    |
| Triggers de integridad (bootstrap, concesión, recuperación, tokens, sesiones, auditoría)                       | Hechos. Probados en PGlite (PG 18.6) y, la concurrencia, en un **clúster PG 18.0 real desechable** |
| Lógica pura: `resolveAccess`, `grant-policy`, `resource-authorization`, `session-policy`                       | Hecha y probada (unitarias/contractuales)                                                          |
| Hash de contraseñas, servicio de sesiones, CSRF, rate limiting, **endpoints**, MFA, CLI de bootstrap, frontend | **No implementados.** Nada de esto debe considerarse seguro todavía: solo está diseñado            |

## 2. Alternativas evaluadas

| Criterio                                                            | A. Better Auth                                                                          | B. Sesiones propias + bibliotecas mantenidas                               | C. Solo primitivas de Node  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------- |
| Registro público deshabilitado                                      | `disableSignUp`; el alta pasa por el plugin admin, que crea usuarios **con contraseña** | Sin ruta de registro                                                       | Igual que B                 |
| Caducidad absoluta, inactividad, política por rol, tope de sesiones | **No documentados**: solo `expiresIn` + `updateAge` deslizante                          | Nativo (`roles`, trigger de sesiones)                                      | Igual que B                 |
| RBAC                                                                | Roles como **texto separado por comas**, permisos **estáticos en código**               | Tablas relacionales, dominios, historial, alcance                          | Igual que B                 |
| Separación de funciones (quién concede qué)                         | No modelada                                                                             | Constraints y triggers propios                                             | Igual que B                 |
| MFA                                                                 | Plugin 2FA (TOTP, respaldo) **opt-in por usuario**; no obligatorio por rol              | TOTP con biblioteca mantenida; `roles.requires_mfa`                        | TOTP propio: **descartado** |
| CSRF / rate limit                                                   | Integrados                                                                              | `SameSite` + `Origin`/`Sec-Fetch-Site` + token HMAC; `@fastify/rate-limit` | Igual que B                 |
| Fastify / Drizzle / Android                                         | Guía oficial _catch-all_; esquema generado por su CLI; plugin bearer                    | Nativo; refresh rotativo + concesión offline (§13)                         | Nativo                      |
| Riesgo de dependencia                                               | Biblioteca joven de alto ritmo; dueña de rutas, esquema y errores                       | Dependencias pequeñas de transporte                                        | Más superficie propia       |

Fuente: documentación oficial de Better Auth (sesiones, plugin admin, 2FA, opciones, Fastify) y de Node.js (`crypto.argon2`, desde v24.7.0, módulo `crypto` estable).
**Decisión: B.** Better Auth cubre bien lo que ETA 15 no necesita (registro, OAuth, organizaciones) y no lo que sí exige (política de sesión por rol, RBAC relacional, separación de funciones, 2FA obligatorio por rol). Las piezas criptográficas no son propias: Argon2id y el azar vienen de `node:crypto`; TOTP vendrá de una biblioteca mantenida; el transporte, de plugins oficiales de Fastify.

## 3. Arquitectura

```
Navegador ── cookie HttpOnly + X-CSRF-Token ──> Fastify
  onRequest: token → SHA-256 → fila vigente de sessions → request.auth
  preHandler: requirePermission(clave) → authorizeGroupResource / listFilter → consulta ya filtrada
                                   │
        PostgreSQL: users, roles, permissions, role_permissions, user_roles, sessions, auth_tokens, audit_events
                    + triggers de integridad (última defensa, independientes de la aplicación)
```

## 4. Modelo de amenaza y separación de privilegios

**Principio**: el acceso a datos escolares lo autoriza únicamente Dirección. El administrador técnico administra configuración y soporte, y no puede darse ni dar acceso escolar, ni suplantar a nadie.

**Dominios.** Cuentas y roles son `school` o `technical`; los permisos, `school`, `technical` o `shared`. Los permisos de **autoridad** (`users:manage_*`, `roles:grant_*`, `roles:manage_*`, `is_authority = true`) no se delegan por la API.

| Garantía                                                                                                                                                 | Mecanismo                                                         |            ¿Depende de que la API NO sea propietaria?             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | :---------------------------------------------------------------: |
| Una cuenta solo recibe roles de su dominio; un rol solo contiene permisos de su dominio o compartidos (`admin_tecnico` jamás tendrá `students:*`)        | FK compuestas + CHECK                                             |                                No                                 |
| Nadie se concede un rol a sí mismo                                                                                                                       | CHECK `user_roles_grantor_valid`                                  |                                No                                 |
| Concede/revoca solo una cuenta **activa** con `roles:grant_<dominio>`, con bloqueo `FOR SHARE` (sin carreras con revocaciones o bajas)                   | Triggers `user_roles_enforce_grant`/`guard_update`                |                                No                                 |
| Las asignaciones no se borran ni se editan (solo se revocan); el historial sostiene el cierre del bootstrap                                              | Triggers `no_delete`, `guard_update`                              |             No (el propietario puede quitar triggers)             |
| Conceder/revocar se audita y **revoca las sesiones** del afectado                                                                                        | Trigger `user_roles_audit_and_revoke`                             |                                No                                 |
| Agregar/quitar permisos de **autoridad** a un rol, bootstrap y recovery                                                                                  | Trigger + `auth_is_schema_owner()`                                |                              **Sí**                               |
| Crear cuentas: pendientes, sin contraseña, con creador activo que tenga `users:manage_<dominio>`                                                         | Trigger `users_enforce_creator`                                   | **Sí** (el propietario las crea sin creador, p. ej. en bootstrap) |
| Un cambio en `role_permissions` queda auditado (con atribución opcional `eta15.actor_id`); nunca UPDATE (un scope se ensancha con baja + alta auditadas) | Triggers `role_permissions_guard/audit`                           |                                No                                 |
| La clave/dominio de un rol o permiso no cambia; roles de sistema no se borran; cambios de MFA/sesión se auditan                                          | Triggers `roles_guard`, `permissions_guard`, `roles_audit_update` |                                No                                 |

Reglas de aplicación (`grant-policy`): cada dominio administra sus cuentas (alta, invitación, recuperación, reactivación); el admin técnico solo puede **reducir** acceso a cualquier cuenta (deshabilitar, cerrar sesiones); nadie amplía un rol que posee; ningún permiso de autoridad se edita por la API.

## 5. Bootstrap y rescate

Pregunta de diseño: _la ausencia de usuarios no debe dar capacidad a cualquier solicitante._ Se verificó que la versión anterior **sí** lo permitía (ver §14, riesgos confirmados). Diseño vigente:

| Aspecto              | Bootstrap (primer titular de un dominio)                                                                    | Recovery (rescate: el dominio existió pero no quedan titulares activos con autoridad) |
| -------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Quién                | Solo el **propietario del esquema** (rol de migraciones/consola), nunca el rol de la API ni HTTP            | Igual                                                                                 |
| Autorización inicial | Acta institucional obligatoria: `grant_reference` de 3–200 caracteres, auditada                             | Igual                                                                                 |
| Qué rol              | Solo uno que contenga `roles:grant_<dominio>` (no se inicializa con un rol operativo)                       | Igual                                                                                 |
| Cada dominio         | Se evalúa por `domain`: se inicializa por separado `technical` y `school`                                   | Igual                                                                                 |
| Concurrencia         | Bloqueo consultivo por dominio + exige `READ COMMITTED`; el segundo espera y falla (**probado en PG real**) | Igual                                                                                 |
| Cierre               | **Permanente**: cualquier fila histórica del dominio lo impide; el historial no se borra                    | Solo con 0 titulares activos con autoridad                                            |
| Auditoría            | `role.granted` con `source` y `reference`                                                                   | Igual                                                                                 |

**Ceremonia** (herramienta de consola `auth:bootstrap`, a implementar): el operador crea la cuenta _pendiente_ y ejecuta el bootstrap con la persona presente; la persona genera su secreto en **su** navegador y registra su hash (§6); el operador cotejando el código en pantalla emite la autorización `verification_method = 'ceremony'` (solo propietario, solo para un titular de bootstrap/recovery); la persona define su contraseña. El operador nunca conoce el secreto ni la contraseña.
**Perder a todos los titulares**: el dominio no queda "abierto" para cualquiera; se usa `recovery` por el propietario con nueva acta, tras la cual el recovery vuelve a cerrarse.
**Límite honesto**: mientras la API se conecte con el mismo rol que es propietario (hoy, `eta15_app`), las guardas "solo propietario" **no protegen** frente a la API; el bootstrap y el recovery quedan protegidos únicamente por procedimiento. Se activan al separar roles (§10, ADR 0003). Quien tenga la credencial del propietario puede, además, deshabilitar triggers: es el techo de confianza de cualquier diseño en base de datos.

## 6. Activación de cuentas y recuperación de contraseña (sin proveedor de correo)

Decisión aprobada: la autoridad puede iniciar o **autorizar** una recuperación, pero no suplantar al titular. Modelo de **reclamo en dos partes** sobre `auth_tokens` (invitación = `invite`, recuperación = `password_reset`):

1. **Titular**: su navegador genera un secreto de 256 bits y registra solo su SHA-256 (`token_hash`). La pantalla muestra un código corto derivado del hash. La solicitud nace _sin autorizar_ y caduca (≤ 24 h; recomendado 30 min).
2. **Autoridad del dominio** (Dirección para cuentas escolares; admin técnico para técnicas; **otra persona**, nunca la propia cuenta) verifica la identidad **en persona** (`in_person_id` o `in_person_known`; no se guardan números de documento), coteja el código y **autoriza**. No ve el secreto ni la contraseña.
3. **Titular** completa con el secreto: consumo atómico (`UPDATE … WHERE used_at IS NULL AND authorized_at IS NOT NULL AND expires_at > now() RETURNING`); el trigger fija `used_txid` y solo en esa misma transacción puede pasar una cuenta `pending` a `active`. Cambiar la contraseña revoca todas sus sesiones.

| Requisito                                                            | Cómo se cumple                                                                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| La autoridad no elige ni consulta la contraseña; no obtiene el token | El secreto nace en el navegador del titular; solo existe su hash en BD                                                                                   |
| No puede sustituir el secreto                                        | `token_hash`, `user_id`, `purpose`, `expires_at` son inmutables (trigger)                                                                                |
| No obtiene una sesión como el titular                                | No existe suplantación/“impersonate”; las sesiones solo nacen del login con contraseña (+ MFA)                                                           |
| No puede desactivar MFA para eludir                                  | No existe endpoint ni permiso que desactive un factor; el reinicio de MFA es un procedimiento presencial aparte (decisión pendiente D6)                  |
| Un solo uso, hash, caducidad, concurrencia                           | Una transición por `UPDATE`, estados terminales, índice de un solo token vigente por (usuario, propósito); **20 intentos paralelos ⇒ 1 éxito** (PG real) |
| La API no puede preautorizar ni activar “a mano”                     | Trigger de inserción (nace sin autorizar) y de activación (`used_txid`)                                                                                  |
| Autorizar exige autoridad vigente y activa                           | `auth_lock_authority` con `FOR SHARE`                                                                                                                    |

**Riesgos residuales** (no eliminables sin un canal verificable): una autoridad maliciosa puede registrar _ella misma_ la solicitud de otra persona, “autorizarla” y quedarse con el secreto. Mitigaciones: el requisito de MFA (el secreto solo restablece la contraseña, no el segundo factor), control dual entre pares para cuentas privilegiadas (quien autoriza es otro titular del dominio), auditoría con autor y origen, y aviso en el siguiente inicio de sesión del titular. Hasta que exista MFA, **las cuentas con `requires_mfa` no deben usarse con datos reales**. **No hay recuperación remota** y no se implementa proveedor de correo; el procedimiento presencial descrito es el único.

## 7. Modelo de datos definitivo (8 tablas, todas propias)

| Tabla              | Reglas principales                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`            | UUID v7; `email` normalizado y único; `email_kind` (personal activo ⇒ `email_verified_at`); `account_domain` inmutable; `status` pending/active/disabled; `active` exige contraseña; sin borrado físico |
| `roles`            | `key`, `domain`, `is_system`, `requires_mfa`, `session_idle_minutes`, `session_absolute_minutes`, `max_concurrent_sessions`; ampliable con filas                                                        |
| `permissions`      | `key` `recurso:acción`, `domain`, `is_authority`                                                                                                                                                        |
| `role_permissions` | PK (rol, permiso), `scope`, dominios denormalizados con FK compuestas; solo alta/baja                                                                                                                   |
| `user_roles`       | Historial: `granted_by`, `grant_source` (grant/bootstrap/recovery), `grant_reference`, `revoked_at/by`; vigente único por (usuario, rol)                                                                |
| `sessions`         | `token_hash` bytea(32) único, `client_type`, `expires_at` (absoluta), `idle_expires_at`, `mfa_verified_at`, revocación con motivo                                                                       |
| `auth_tokens`      | Reclamo en dos partes (§6): `authorized_*`, `verification_method`, `used_at/used_txid`, `invalidated_at`                                                                                                |
| `audit_events`     | Solo inserción para quien no sea propietario; `details` sin secretos                                                                                                                                    |

Diferidas: factores MFA y códigos de respaldo (etapa MFA), dispositivos/cadena de refresh Android, rate limit en BD, retención/particionado de auditoría (decisión institucional).

## 8. Autorización por alcance, recurso y campo

Significado de `scope` y su traducción a comprobaciones concretas (`resource-authorization.ts`, **contratos con puertos simulados**; las tablas de alumnos, asistencia y asignaciones aún no existen y no se inventaron):

| Scope             | Significado                                                                                 | Aplicación obligatoria                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `all`             | Todos los registros                                                                         | Sin filtro de alcance                                                                                                                                                                     |
| `assigned_groups` | Grupos con asignación vigente del usuario en la fecha (`prefect_group_assignments`, futura) | Listados: `WHERE group_id = ANY(:ids)` con `listFilter`; **conjunto vacío ⇒ `none` (cero filas), jamás “sin filtro”**. Por id: `authorizeGroupResource` con el `groupId` leído de la base |
| `own`             | Registros propios                                                                           | Filtro por usuario; no aplica a recursos de grupo                                                                                                                                         |

Reglas de todo endpoint de datos escolares: (1) permiso funcional, denegar por defecto; (2) el `groupId` sale del registro guardado, no de la petición — una prefecta de 1A no ve 2B cambiando un UUID; (3) listados filtrados en la consulta; (4) campos sensibles con `projectFields` (`students:read_basic` ≠ `students:read`; un campo sin regla no se devuelve); (5) cuenta, roles y asignaciones se leen frescos en cada petición, por lo que una cuenta deshabilitada, un rol revocado o una asignación revocada niegan al instante; (6) fuera de alcance e inexistente son indistinguibles para el cliente; (7) lotes: todo o nada; (8) toda denegación se audita (`authz.denied`).

## 9. Sesiones (política aprobada, aplicada en la base)

| Perfil           | Inactividad | Absoluta | Tope |
| ---------------- | ----------- | -------- | ---- |
| Personal general | 60 min      | 12 h     | 5    |
| `direccion`      | 30 min      | 8 h      | 5    |
| `admin_tecnico`  | 15 min      | 8 h      | 5    |

Configurable en `roles`; con varios roles rige el valor más estricto. La base **impone** lo que no puede dejarse a la aplicación: solo cuentas activas abren sesión; el tope se aplica con bloqueo de la fila del usuario (12 inicios simultáneos ⇒ 5 vigentes, **probado en PG real**); cambiar la contraseña, deshabilitar la cuenta o cambiar sus roles revoca todas sus sesiones. La aplicación hará lo demás en una transacción: validar token/caducidad/inactividad, renovar `idle_expires_at` sin superar `expires_at`, abrir sesión nueva tras cambiar contraseña. Token de 256 bits aleatorios, solo su SHA-256 en BD; cookie `HttpOnly`, `Secure` en producción, `SameSite=Lax`; CSRF con `Origin`/`Sec-Fetch-Site` + token HMAC; CORS con credenciales; `redact` de `set-cookie` y secretos. La longitud del hash es lo único que la BD valida: que sea un SHA-256 de un token aleatorio es responsabilidad (y prueba) de la etapa 3.

### 9.1 Servicio de contraseñas (implementado: `src/modules/auth/password.ts`)

- **Tecnología**: `crypto.argon2` de `node:crypto` (Node ≥ 24.7, Argon2id). Sin dependencias nativas ni de terceros. Se descartó añadir la biblioteca `argon2`: la derivación ya es estándar en Node, y lo que falta (codificar/decodificar una cadena PHC, ~60 líneas, y `timingSafeEqual`) no es criptografía propia. El formato es el PHC estándar, así que migrar a otra biblioteca no obligaría a re-hashear.
- **Formato almacenado**: `$argon2id$v=19$m=<KiB>,t=<pasadas>,p=<paralelismo>$<sal b64>$<hash b64>` (base64 sin relleno). Sal de 16 bytes del CSPRNG, independiente por hash; etiqueta de 32 bytes. Los parámetros viajan dentro de cada hash.
- **Parámetros iniciales** (configurables al crear el servicio): 64 MiB, 3 pasadas, p = 1 (≈ 100 ms medidos aquí). Mínimos aceptados al crear: los de OWASP (19 MiB, t = 2, p = 1). Al **leer** un hash se rechazan parámetros absurdos (memoria > 1 GiB, t > 10, p > 16) para que un registro corrupto no agote el servidor.
- **Actualización de parámetros**: `needsRehash(hash)` es `true` si los parámetros del hash difieren de los vigentes; `verify` usa siempre los parámetros del propio hash, así que al subir el coste los hashes viejos siguen funcionando hasta que el inicio de sesión correcto los re-hashee.
- **Entrada**: normalización Unicode NFKC (NIST SP 800-63B), máximo 1024 bytes UTF-8, no vacía; sin truncado (no hay límite de 72 bytes). La política de complejidad/lista de contraseñas comunes **no** está implementada (pendiente de decisión institucional).
- **Comparación** en tiempo constante (`timingSafeEqual`); `decoyVerify` gasta el mismo tiempo que una verificación real para usuarios inexistentes (el endpoint de login lo usará).
- **Errores** (`PasswordError`): solo un código y un mensaje fijo; nunca la contraseña, el hash ni la sal. Un hash almacenado corrupto **lanza** (no devuelve `false`) para distinguir integridad de credencial incorrecta.
- Memoria: cada derivación usa 64 MiB; Node ejecuta `crypto.argon2` en el pool de hilos de libuv (4 por defecto), lo que acota la concurrencia a ~256 MiB. El **límite de intentos** (rate limiting) llega con los endpoints.

### 9.2 Servicio de sesiones (implementado: `src/modules/auth/session-service.ts`, sin Fastify)

| Operación                                            | Qué hace                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create({ userId, clientType, ip, … })`              | Transacción: bloquea la fila del usuario (`FOR UPDATE`), exige cuenta activa, sin bloqueo temporal y con al menos un rol vigente; calcula caducidades con la política más estricta de sus roles; inserta solo el SHA-256 del token (256 bits del CSPRNG, base64url) y devuelve el token **una sola vez**. El trigger impone el tope de 5. |
| `verify(token, { touch })`                           | Hash del token → sesión → **revalida** cuenta, bloqueo, `password_changed_at`, roles vigentes y permisos (con alcance); aplica la política vigente (puede ser más estricta que la de la creación); renueva `last_seen_at`/`idle_expires_at` (sin superar la absoluta, y como mucho cada 30 s). Resultados negativos como datos.           |
| `revokeByToken`, `revokeSession`, `revokeAllForUser` | Revocación individual (logout), por id con autor y motivo, y global por usuario (con excepción opcional). Idempotentes; motivos limitados a los del `CHECK`.                                                                                                                                                                              |

- Motivos de fallo: `invalid_token`, `revoked`, `idle_expired`, `absolute_expired`, `account_inactive`, `account_locked`, `no_active_roles`, `password_changed`, `mfa_required`. **La capa HTTP debe responder igual (401 genérico) a todos** (excepto el aviso explícito de MFA que decida el login). **Sin sesiones parciales**: si algún rol vigente exige MFA (`direccion`, `admin_tecnico`) y no hay segundo factor verificado, `create` rechaza la sesión y `verify` no autoriza aunque la fila exista.
- Nada de autoridad vive en el token. Aunque una creación concurrente lea roles antes de que se revoquen, `verify` los revalida en cada petición y los triggers revocan las sesiones existentes.
- Usa solo SQL parametrizado y las columnas concedidas a `eta15_api` (no puede cambiar `token_hash`, `user_id` ni `expires_at` de una sesión: probado con los privilegios reales). `password_changed_at` **debe** actualizarse en el flujo de cambio de contraseña (defensa adicional al trigger).
- El token no se registra: los resultados y errores no lo contienen; sin JWT. La cookie, CSRF y el rate limiting corresponden a la capa HTTP (aún no implementada).

## 10. Auditoría y roles de PostgreSQL

La auditoría **no es absolutamente inmutable**. Protección real: sin UPDATE/DELETE/TRUNCATE para quien no sea propietario (trigger `ENABLE ALWAYS`, que sigue disparando aun con `session_replication_role = replica`; el rol de la API no puede alterar ni quitar el trigger: _must be owner_). Límite probado: **el propietario o un superusuario puede deshabilitar el trigger y modificar eventos**. Mitigaciones: separar roles (abajo), custodiar la credencial del propietario, exportar la auditoría a un registro externo y, más adelante, encadenar hashes.

**Funciones SQL (revisión previa a aplicar)**: son 20 (1 de la migración 0001 y 19 nuevas); ninguna es `SECURITY DEFINER`, todas fijan `search_path = pg_catalog, pg_temp` y califican `public.`. PostgreSQL concede `EXECUTE` a `PUBLIC` por defecto, así que 0005 lo **revoca de todas** (bucle limitado al esquema `public`) y termina con una aserción que **hace fallar la migración** si queda alguna abierta, `SECURITY DEFINER` o sin `search_path` fijo (probado). Al separar roles bastará `GRANT EXECUTE` de los tres ayudantes `auth_*` al rol de la API; sin eso la API no puede operar (probado). Las funciones de trigger no requieren `EXECUTE` al dispararse. **Hallazgo**: un rol con el privilegio de tabla `TRIGGER` puede adjuntar un trigger propio (con función temporal) que reescribe `granted_by` antes de las guardas y se autoasciende a `direccion` (**demostrado** en `auth-functions.test.ts`). Por eso el rol de la API **nunca** recibe `TRIGGER` (ni `ALL`), y debe verificarse con `tools/db/04-audit-privileges.sql`.

**La futura API necesitará un rol de ejecución distinto del propietario** (trabajo de la ADR 0003; **no se cambió ningún rol real**). Matriz propuesta (se prueba hoy con un rol simulado con _todos_ los privilegios de tabla como peor caso):

| Rol           | Atributos                                                                                                             | Privilegios                                                                                                                                                                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eta15_owner` | Propietario de tablas y funciones; solo migraciones y consola (bootstrap/recovery); sin acceso desde la red de la API | DDL, todo                                                                                                                                                                                                                                                                                                              |
| `eta15_api`   | LOGIN, **no** propietario y **no** miembro de `eta15_owner`                                                           | SELECT en todo; INSERT en `users`, `user_roles`, `sessions`, `auth_tokens`, `audit_events`; UPDATE en `users`, `user_roles`, `sessions`, `auth_tokens`; DELETE solo en `sessions`/`auth_tokens` (purga); `role_permissions` **solo SELECT** (aplicado 2026-10-26); sin TRUNCATE ni DDL; idealmente UPDATE por columnas |

## 11. MFA

Obligatorio para `admin_tecnico` y `direccion` antes de usar datos reales (`roles.requires_mfa`, `sessions.mfa_verified_at`). TOTP (RFC 6238) con biblioteca mantenida, secretos cifrados en reposo, códigos de respaldo con hash; sin factor enrolado, solo sesión limitada de enrolamiento; sin función que desactive un factor; el reinicio de MFA requiere el procedimiento presencial con control dual.

## 12. Matriz de permisos

`✓` todos · `G` grupos asignados · `B` datos básicos · `—` ninguno · `(A)` autoridad.

| Permiso                                                                           | prefectura | trabajo_social | control_acceso | direccion | admin_tecnico |
| --------------------------------------------------------------------------------- | :--------: | :------------: | :------------: | :-------: | :-----------: |
| `catalog:read`                                                                    |     ✓      |       ✓        |       ✓        |     ✓     |       ✓       |
| `roles:read` · `users:read` (sin datos escolares)                                 |     —      |       —        |       —        |     ✓     |       ✓       |
| `catalog:manage`                                                                  |     —      |       —        |       —        |     —     |       ✓       |
| `students:read_basic`                                                             |     G      |       ✓        |      ✓ B       |     ✓     |       —       |
| `students:read` (expediente)                                                      |     G      |       ✓        |       —        |     ✓     |       —       |
| `students:manage`, `enrollments:manage`                                           |     —      |       —        |       —        |   ✓ (*)   |       —       |
| `attendance:capture`                                                              |     G      |       —        |       —        |     —     |       —       |
| `attendance:read`                                                                 |     G      |       ✓        |       —        |     ✓     |       —       |
| `attendance:correct`                                                              |     —      |       —        |       —        |   ✓ (*)   |       —       |
| `justifications:read`                                                             |     G      |       ✓        |       —        |     ✓     |       —       |
| `justifications:manage`                                                           |     —      |       ✓        |       —        |     —     |       —       |
| `access:scan`                                                                     |     —      |       —        |       ✓        |     —     |       —       |
| `access:read`                                                                     |     —      |       —        |       ✓        |     ✓     |       —       |
| `reports:read`                                                                    |     —      |       —        |       —        |     ✓     |       —       |
| `users:manage_school` · `roles:grant_school` · `roles:manage_school` (A)          |     —      |       —        |       —        |     ✓     |       —       |
| `users:manage_technical` · `roles:grant_technical` · `roles:manage_technical` (A) |     —      |       —        |       —        |     —     |       ✓       |
| `users:disable_any` · `users:revoke_sessions_any` (solo reducen acceso)           |     —      |       —        |       —        |     —     |       ✓       |
| `audit:read` · `system:config`                                                    |     —      |       —        |       —        |     —     |       ✓       |

(*) Supuestos de Dirección a confirmar. Los roles no son un conjunto cerrado: se agregan filas; los permisos de autoridad solo por migración.

## 13. Contratos de API propuestos y Android (sin implementar)

Prefijo `/v1` (`/api/v1/...` en el navegador); errores con el formato común; mutaciones con `X-CSRF-Token`.

| Ruta                                                                | Permiso                                                  | Notas                                                   |
| ------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| `POST /v1/auth/login` · `logout` · `GET me`                         | pública+rate limit · sesión                              | 401 idéntico en todos los fallos; 429 con `Retry-After` |
| `POST /v1/auth/credential-requests` `{email,purpose,secretHash}`    | pública+rate limit                                       | Crea la solicitud (§6); siempre 202; muestra el código  |
| `POST /v1/auth/credential-requests/complete` `{secret,newPassword}` | token autorizado                                         | Consumo atómico y activación/cambio en una transacción  |
| `GET /v1/admin/credential-requests` · `POST …/:id/authorize`        | `users:manage_<dominio>`                                 | Verificación presencial; nunca la propia cuenta         |
| `POST/GET/PATCH /v1/admin/users…` · `PUT …/:id/roles`               | `users:manage_<d>` · `roles:grant_<d>`                   | `grant-policy` + triggers                               |
| `POST …/:id/disable` · `…/revoke-sessions`                          | `users:disable_any`/`revoke_sessions_any` o `manage_<d>` | Solo reducen acceso                                     |
| `GET /v1/admin/roles` · `PUT …/roles/:key/permissions`              | `roles:read` · `roles:manage_<d>`                        | No permisos de autoridad; cada cambio auditado          |
| `GET /v1/admin/audit-events`                                        | `audit:read`                                             | Cursor                                                  |

Android: sesiones web y autorización offline son distintas. Refresh token opaco de un solo uso con rotación y detección de reutilización (reuso ⇒ revocar la familia), en Keystore; concesión offline **firmada** (usuario, permisos, grupos; ~72 h) verificada por la app; sin validar contraseñas localmente (desbloqueo del dispositivo); capturas con UUID v7 del cliente, revalidadas en el servidor al sincronizar contra la asignación vigente de ese grupo y fecha; la revocación surte efecto al reconectar (límite aceptado). `sessions.client_type = 'android'` ya existe.

## 14. Auditoría de seguridad: riesgos confirmados con evidencia

Reproducidos contra el esquema anterior con un rol de API simulado (no propietario, todos los privilegios de tabla) o con conexiones reales concurrentes:

| #   | Riesgo confirmado                                                                                                    | Corrección                                          |
| --- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| R1  | El rol de la API hacía bootstrap de `direccion` solo por estar el dominio vacío                                      | Solo propietario + acta + rol con `roles:grant_*`   |
| R2  | Al renunciar el único titular, el bootstrap se reabría sin acta                                                      | Cierre permanente por historial; recovery aparte    |
| R3  | Se podía borrar el historial de `user_roles`                                                                         | Triggers `no_delete`/`no_truncate`                  |
| R4  | Cambiar `password_hash` no revocaba sesiones                                                                         | Trigger                                             |
| R5  | Se creaban sesiones para cuentas pendientes                                                                          | Trigger de sesiones                                 |
| R6  | `roles.domain` mutable; rol de sistema borrable                                                                      | `roles_guard`, `permissions_guard`                  |
| R7  | La API podía **delegar autoridad** (`roles:grant_school` a prefectura)                                               | `is_authority` + propietario                        |
| R8  | Cambios en `role_permissions` sin auditoría                                                                          | Trigger de auditoría                                |
| R9  | La API creaba cuentas sin creador ni autoridad                                                                       | `users_enforce_creator`                             |
| R10 | (Descartado) TRUNCATE de auditoría con la API sin privilegio                                                         | Ya bloqueado por privilegios; además trigger        |
| C1  | **Dos bootstrap concurrentes crearon 2 primeros titulares** (PG 18.0 real)                                           | Bloqueo consultivo + `READ COMMITTED`               |
| D1  | Diseño: el administrador veía el token de recuperación y podía suplantar al titular                                  | Reclamo en dos partes (§6)                          |
| D2  | `CHECK` con `NULL` aceptaba bootstrap **sin acta** (hallado por las pruebas)                                         | `IS NOT NULL` explícito                             |
| D3  | Ligar activación y consumo con `now()` era frágil (reloj de 1 ms en PGlite)                                          | `used_txid` (ID de transacción), no falseable       |
| F1  | Las 20 funciones eran ejecutables por `PUBLIC` (valor por defecto; no elevan privilegios por ser `SECURITY INVOKER`) | `REVOKE` + aserción final en 0005                   |
| F2  | El privilegio `TRIGGER` permite adjuntar triggers propios y esquivar la política de concesión (**demostrado**)       | No se concede jamás; `04-audit-privileges.sql`      |
| F3  | `pnpm test` ejecutaba también la suite del clúster desechable                                                        | `test/pgtemp/**` excluido; solo `pnpm test:pg-temp` |

Descartados con evidencia: el rol de la API no puede alterar ni quitar el trigger de auditoría (_must be owner_); no puede UPDATE/DELETE/TRUNCATE auditoría; el dominio de un rol no cruza dominios (FK/CHECK); la concesión concurrente respeta la revocación (espera, 12/12 pruebas reales).

## 15. Plan e hitos

| Etapa             | Contenido                                                        | Criterio verificable                                                                                                | Estado                                                                                              |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1. Datos          | Esquema, triggers, semilla                                       | Pruebas adversariales PGlite + concurrencia PG real; aplicación en `eta15_dev` con respaldo, preflight y `ROLLBACK` | Esquema y pruebas **hechos**; aplicación pendiente                                                  |
| 2. Servicios      | Hash Argon2id, tokens, política de contraseñas, CLI de bootstrap | Parámetros PHC, coste igual para usuario inexistente, sin secretos en logs                                          | Contraseñas (Argon2id) **hecho**; tokens de reclamo, política de contraseñas y bootstrap pendientes |
| 3. Sesiones       | Crear/validar/renovar/revocar, cookie, CSRF                      | Caducidades por rol, CSRF 403, atributos de cookie                                                                  | Política, reglas de BD y **servicio hechos**; cookie/CSRF pendientes                                |
| 4. Permisos       | Guards en rutas                                                  | Matriz §12 parametrizada; contratos de recurso                                                                      | Lógica pura **hecha**; guards pendientes                                                            |
| 5. Endpoints      | login/logout/me/solicitudes de credencial                        | 401 idéntico; 429; sin secretos                                                                                     | Pendiente                                                                                           |
| 6. Administración | Cuentas, roles, autorizaciones, auditoría                        | Pruebas de escalamiento **por HTTP**                                                                                | Reglas hechas; endpoints pendientes                                                                 |
| 7. MFA            | TOTP                                                             | Obligatorio por rol                                                                                                 | Pendiente — **antes de datos reales**                                                               |
| 8. Frontend       | `AuthProvider`, login, guards (solo UX)                          | Flujo completo                                                                                                      | Pendiente                                                                                           |
| 9. Cierre         | Revisión ASVS 5.0.0 V6/V7/V8 con evidencia                       | Lista firmada; integración real                                                                                     | Pendiente                                                                                           |

## 16. Pruebas: qué demuestra cada tipo

| Tipo                                            | Archivos                                                                      | Qué demuestra / límites                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Unitarias/contractuales (sin BD)                | `access-control`, `resource-authorization`, `session-policy`, `drizzle-guard` | Reglas puras y **contratos** que los endpoints futuros deben cumplir; no prueban endpoints                                      |
| De esquema en PGlite (PG 18.6, memoria)         | `auth-schema`, `auth-privileges`, `auth-recovery`, `auth-seed`                | Constraints y triggers, con un rol de API **simulado no propietario y con todos los privilegios**                               |
| Concurrencia real (PG 18.0, clúster desechable) | `test/pgtemp/concurrency.pg.test.ts` (`pnpm test:pg-temp`)                    | Bootstrap simultáneo, consumo paralelo de tokens, concesión vs revocación, tope de sesiones, protección frente al rol de la API |
| Integración con `eta15_dev`                     | `test:integration`                                                            | No cubre Auth: nada se ha aplicado                                                                                              |

No cubierto: HTTP, hash, cookies/CSRF, rate limit, MFA, rendimiento, y las guardas “solo propietario” mientras API y propietario sean el mismo rol.

## 17. Mapeo con ASVS 5.0.0 (capítulos)

| Capítulo             | Cubierto por diseño/esquema                                                                                                                                           | Pendiente                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| V6 Autenticación     | Argon2id y política de contraseñas (diseño), mismo coste y mensaje en fallos (diseño), activación/recuperación sin que la autoridad conozca secretos, MFA planificado | Implementación, MFA, rate limit, lista de contraseñas comunes |
| V7 Sesiones          | Token opaco hasheado, caducidad absoluta/inactividad por rol, tope y revocación impuestos en BD, rotación en login (diseño)                                           | Cookie/CSRF, renovación, cierre de sesión                     |
| V8 Autorización      | Denegar por defecto, separación de funciones, dominios, alcance por grupo y campo (contratos), autorización en backend                                                | Guards en rutas y pruebas por HTTP                            |
| Registro y auditoría | `audit_events` solo inserción (con límites), atribución, sin secretos                                                                                                 | Servicio de auditoría, exportación externa                    |

## 18. Decisiones pendientes que requieren autorización institucional

| #   | Decisión                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Retención de auditoría y de sesiones                                                                                                 |
| D2  | Supuestos de Dirección marcados (*) en la matriz                                                                                     |
| D3  | Canal de correo (hoy: ninguno; solo procedimiento presencial)                                                                        |
| D4  | Verificación de contraseñas filtradas (HIBP, sale a internet)                                                                        |
| D5  | Quién ejecuta bootstrap/recovery, y formato y custodia del acta                                                                      |
| D6  | Procedimiento y control dual para reiniciar el MFA de una cuenta privilegiada                                                        |
| D7  | Un suplente de Dirección (segundo titular) para no depender de una sola persona                                                      |
| D8  | Cuándo separar los roles de PostgreSQL (`eta15_owner`/`eta15_api`): condiciona que las guardas “solo propietario” protejan de verdad |
