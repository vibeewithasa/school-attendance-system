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

**Ceremonia implementada** (`pnpm auth:bootstrap`, [bootstrap.ts](../../apps/api/src/modules/auth/bootstrap.ts) + [bootstrap-authority.ts](../../apps/api/scripts/bootstrap-authority.ts)): procedimiento de consola **separado de la API** (no existe endpoint de bootstrap) que usa la identidad del migrador (`apps/api/.env.migrator`, `eta15_app`, verificada con `checkOwnerConnection`). Se ejecuta con la **persona titular presente**:

```powershell
. .\tools\env.ps1
pnpm auth:bootstrap -- --domain technical --email persona@escuela.mx --name "Nombre completo" --acta "ACTA-AAAA-NNN"
```

1. Exige `--domain`, `--email`, `--name` y `--acta` (3–200 caracteres) y que se **reescriba el acta** como confirmación. El acta es evidencia humana que queda en `user_roles.grant_reference` y en la auditoría; **no prueba por sí sola** que exista autorización institucional.
2. La contraseña la **teclea la persona titular** en un prompt oculto con doble captura (mínimo 12 caracteres; solo terminal interactiva, nunca por argumentos, variables de entorno, archivo o tubería; no se imprime ni se registra). Quien opera la consola no la conoce.
3. En **una transacción** (READ COMMITTED) del propietario: cuenta `pending` → rol de bootstrap (`direccion` para `school`, `admin_tecnico` para `technical`) → token de invitación de un solo uso generado en memoria (su secreto se descarta) → autorización `ceremony` → consumo → activación con el hash Argon2id → auditoría (`bootstrap.executed` y `role.granted`). No abre sesión.
4. **No se repite**: el CLI lo comprueba y el trigger lo rechaza para siempre si el dominio tiene cualquier asignación histórica; dos ejecuciones simultáneas ⇒ exactamente una (probado en PG real con dos conexiones). Después solo existe `recovery`, con nueva acta.
5. **Estado por dominio** (`BOOTSTRAP_PROCEDURES`): `technical` habilitado; **`school` BLOQUEADO** hasta que la institución defina un procedimiento verificable para acreditar a la primera autoridad escolar (el código está preparado y probado en un clúster desechable con la aprobación simulada, pero el CLI real responde "BLOQUEADO"). Desbloquearlo es un cambio de código revisado, junto con el procedimiento documentado.
6. **No se ha ejecutado contra `eta15_dev`** ni se ha creado ninguna cuenta real.
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

**Estado de la activación (2026-10-26): IMPLEMENTADA** ([activation.service.ts](../../apps/api/src/modules/activation/activation.service.ts), [activation.routes.ts](../../apps/api/src/modules/activation/activation.routes.ts); pantalla `/activar`). Se reutilizó `auth_tokens` y sus triggers, **sin migración nueva ni cambios de privilegios**. Detalle en §9.6. Un token de activación solo se crea para una cuenta **pendiente** que una autoridad ya registró; nadie elige ni conoce la contraseña de otra persona y la finalización no abre sesión.

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
- El token no se registra: los resultados y errores no lo contienen; sin JWT. La cookie, CSRF y el rate limiting son de la capa HTTP (§9.3).

### 9.3 Autenticación HTTP (implementada: `src/modules/auth/auth.routes.ts`, `auth.module.ts`, `auth-service.ts`)

Rutas (sin prefijo `/v1`; en el navegador `/api/auth/*` por el proxy de Vite):

| Ruta                | Requiere                | Resultado                                                                                                                                                                                              |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /auth/login`  | Origen permitido, JSON  | 200 `{ mustChangePassword, session }` + cookie; 400 entrada inválida; **401 idéntico** en cualquier fallo de credenciales/cuenta; **403 `MFA_REQUIRED`** si algún rol exige MFA; 429 con `Retry-After` |
| `POST /auth/logout` | Sesión + `X-CSRF-Token` | 204, revoca la sesión actual (`logout`) y limpia la cookie. Repetido: 401 sin efectos. Enviar sin cuerpo ni `Content-Type`                                                                             |
| `GET /auth/me`      | Sesión                  | Identidad mínima (id, dominio), roles, permisos con alcance y caducidades; revalida cuenta, roles y permisos en cada llamada                                                                           |
| `GET /auth/csrf`    | Sesión                  | `{ csrfToken }` para la sesión actual                                                                                                                                                                  |

- **Cookie**: `HttpOnly`, `SameSite=Strict`, `Path=/`, sin `Domain`, `Expires` = caducidad absoluta de la sesión. Producción: `__Host-eta15_session` + `Secure` (el prefijo `__Host-` lo exige). Desarrollo: `eta15_session`, sin `Secure`. El token nunca va en JSON, URL ni logs; la cookie de desarrollo no sirve en producción. Un login correcto revoca la sesión de la cookie anterior del navegador.
- **Desarrollo local**: usar siempre `http://127.0.0.1:5173` (el servidor de Vite escucha ahí; `localhost` es otro sitio para las cookies y para la lista de orígenes). El proxy `/api` hace las llamadas del mismo origen, así que no hace falta CORS. Para usar `localhost` hay que añadirlo a `CORS_ORIGIN` y acceder siempre por él.
- **CSRF** (no basta SameSite): (1) toda petición que cambia estado (POST/PUT/PATCH/DELETE) debe traer `Origin` en `CORS_ORIGIN` — protege también el **login CSRF**; (2) `Sec-Fetch-Site`, si viene, debe ser `same-origin`/`same-site`; (3) las peticiones autenticadas llevan además `X-CSRF-Token` = HMAC-SHA256 del token de sesión (sin estado, ligado a la sesión, no revela el token). No se leen cabeceras `X-Forwarded-*` (`trustProxy` desactivado). Un cliente de otro _sitio_ (no solo otro origen) no está soportado; el cliente Android necesitará su propio diseño de autenticación.
- **Límites de intentos** (en memoria, antes de Argon2id): fallos por IP (50 / 15 min; una IP compartida como la red de la escuela necesita margen), por pareja IP+correo (5 / 15 min) y por correo desde cualquier IP (30 / 15 min, alto para que un tercero no bloquee con facilidad la cuenta de otra persona), más un tope de inundación por IP del plugin `@fastify/rate-limit` (120 logins/min, 600/min en el resto). Un login correcto limpia la pareja. Limitaciones: el estado se pierde al reiniciar y no se comparte entre instancias (con varias instancias el límite efectivo se multiplica; haría falta un almacén compartido); un atacante distribuido con ≥30 fallos puede frenar una cuenta durante la ventana; llenar el mapa (50 000 claves) expulsa contadores antiguos. No se bloquea la cuenta en la base automáticamente (`locked_until` queda para decisión administrativa).
- **Sin enumeración**: usuario inexistente, sin contraseña, inactivo, bloqueado o contraseña errónea dan la misma respuesta 401 y gastan exactamente una derivación de Argon2id (`decoyVerify` o `verify`), comprobado en las pruebas. El 403 de MFA solo se emite tras una contraseña **correcta**.
- **MFA**: pospuesto por decisión del proyecto (§11). Con `AUTH_MFA_ENFORCEMENT=required` (defecto) `direccion` y `admin_tecnico` reciben 403 `MFA_REQUIRED` y **no se crea sesión**; con `deferred` (solo desarrollo local; rechazado en producción o fuera de loopback) entran con contraseña, la sesión queda sin `mfa_verified_at`, el alta se audita y `GET /auth/me` informa `mfa: { required, enforced, verified }`. No hay sesiones parciales ni bypass oculto.
- **Re-hash en el login**: si los parámetros de Argon2id cambiaron, la actualización de `password_hash` y la creación de la sesión van en una sola transacción, con comparación del hash anterior (un cambio de contraseña concurrente aborta el login). Cambiar `password_hash` revoca las demás sesiones del usuario (trigger; una vez por actualización de parámetros) y no la nueva; `password_changed_at` no se toca.
- **Cambio de contraseña pendiente** (`must_change_password`): la sesión se emite y `/auth/me` lo indica; los guardas de rutas futuras deben rechazarla con 403 salvo en el endpoint de cambio de contraseña (el guarda ya lo hace por defecto, `allowPasswordChange`).
- Cabeceras de seguridad con `@fastify/helmet`; `Cache-Control: no-store` en `/auth/*`; errores 5xx genéricos; los cuerpos de validación no repiten la entrada.

### 9.4 Administración de cuentas (implementada: `src/modules/admin-users/`)

Servicio de dominio ([admin-users.service.ts](../../apps/api/src/modules/admin-users/admin-users.service.ts)) + rutas finas bajo `/admin`, con contratos Zod en `shared-contracts` (`listUsersQuerySchema`, `createUserBodySchema`, `assignRoleBodySchema`; todos `.strict()`: un cuerpo con `password`, `status`, `createdBy`, `grantedBy` o `roles` se rechaza con 400).

| Ruta                                 | Permiso (del actor, desde su **sesión**)             | Efecto                                                                                                                                              |
| ------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/users`                   | `users:read` + `users:manage_<dominio>`              | Lista paginada (`page`, `pageSize` ≤ 100, `status`, `domain`, `role`, `q` ≥ 2 con comodines escapados) solo de los dominios que el actor administra |
| `GET /admin/users/:id`               | igual                                                | Detalle; fuera de alcance o inexistente ⇒ 404 indistinguible                                                                                        |
| `POST /admin/users`                  | `users:manage_<dominio de la cuenta>`                | Cuenta **pendiente** sin contraseña; `created_by` = actor; `user.created`; correo duplicado ⇒ 409                                                   |
| `POST /admin/users/:id/disable`      | `users:manage_<d>` (o `users:disable_any`)           | Deshabilita (trigger revoca sus sesiones); nadie se deshabilita a sí mismo; idempotente; `user.disabled`. No se re-habilita por la API              |
| `GET /admin/roles`                   | `roles:read` + `roles:grant_<d>`                     | Roles de los dominios que el actor puede conceder                                                                                                   |
| `POST /admin/users/:id/roles`        | `roles:grant_<dominio del rol>`                      | Asigna un rol **existente** (`user_roles`, `granted_by` = actor); duplicado ⇒ 409; auditoría y revocación de sesiones por trigger                   |
| `DELETE /admin/users/:id/roles/:key` | igual (renunciar a un rol propio siempre se permite) | Revoca la asignación vigente (el historial se conserva)                                                                                             |

**Reglas de concesión** (pura en `access-control/grant-policy.ts` y repetida por los triggers):

1. El **actor sale solo de la sesión** (`request.auth`); ningún cuerpo o parámetro puede nombrar un actor.
2. Dominios separados: `admin_tecnico` administra solo cuentas y roles `technical`; `direccion` solo `school`. Lo que cae fuera del alcance responde 404; asignar un rol de otro dominio, 403. Reforzado por claves foráneas compuestas en la base.
3. **Nadie se asigna roles a sí mismo** (ni siquiera Dirección) y las concesiones sensibles exigen una autoridad **activa** del dominio (`roles:grant_<d>`), re-validada por el trigger con `FOR SHARE`.
4. Denegar por defecto; toda denegación de permiso queda en `audit_events` (`authz.denied`, sin secretos).
5. **Último titular**: no se puede revocar ni deshabilitar al último titular activo con `roles:grant_<d>` de un dominio (409 `LAST_AUTHORITY`), con bloqueo consultivo por dominio y orden de bloqueo fijo (dos titulares que se quitan el rol a la vez ⇒ solo uno lo logra; 5 ejecuciones del caso concurrente sin interbloqueos; un interbloqueo residual se informa como 409 reintentable, nunca 500).
6. **Edición de permisos de roles (`role_permissions`) fuera de alcance**: la API solo lo lee; los permisos cambian por migración.
7. Puerta de MFA (`adminGuard`): una sesión cuyo rol exige MFA y no lo tiene verificado **no llega** a estas rutas salvo en el modo diferido, que la configuración solo admite fuera de producción y en loopback (§11); en producción nunca se abren a sesiones sin MFA verificado.
8. CSRF (cabecera ligada a la sesión) y `Origin` obligatorios en toda mutación; límite de peticiones por IP; respuestas con `Cache-Control: no-store` y sin `password_hash`, tokens ni contadores internos.

### 9.5 Interfaz de login (`apps/web-admin`)

- Pantalla `/login` (tinto y blanco, responsive, etiquetas y mensajes de error accesibles, foco a la contraseña tras un fallo, estados de carga, espacio reservado para el logotipo — **no se inventó ningún escudo**), `AuthProvider` en memoria y ruta protegida `RequireAuth`. Cerrar sesión pide primero `GET /auth/csrf` y envía `X-CSRF-Token`. Un 401 en cualquier llamada regresa a `/login` sin detalles. No hay recuperación de contraseña ni otros formularios sin flujo real.
- **No se guarda nada en `localStorage`/`sessionStorage`/URL**: la sesión es una cookie `HttpOnly` que el navegador envía (`credentials: 'same-origin'`); el código nunca ve el token. Solo se redirige a rutas internas.
- Origen local único: **`http://127.0.0.1:5173`** (Vite en loopback con proxy `/api` → `127.0.0.1:3000`, mismo origen, sin CORS). Debe coincidir con `CORS_ORIGIN`.

**Cómo probarlo en Windows nativo** (PowerShell, desde `C:\Projects\ETA15`):

1. Entorno **aislado con cuentas ficticias** (recomendado; no toca `eta15_dev`): en una terminal `. .\tools\env.ps1; pnpm dev:sandbox` (levanta un clúster PostgreSQL desechable, la API en `127.0.0.1:3000` con MFA diferido y muestra tres cuentas ficticias (técnica, dirección y prefectura) con contraseñas aleatorias de ese arranque, **solo en una terminal interactiva** (con la salida redirigida las oculta salvo `-- --show-credentials`); se niega a usar el puerto 5432; Ctrl+C lo destruye todo). Con ese entorno se puede probar el flujo completo: entrar como Dirección → `/personal` → «Nueva cuenta» → asignar rol → en otra pestaña `/activar` → «Solicitudes de activación» → verificar con el código → elegir contraseña → iniciar sesión. En otra terminal: `pnpm dev:web` y abrir `http://127.0.0.1:5173`.
2. Contra `eta15_dev` (`pnpm dev:api` con `apps/api/.env`): hoy **no hay ninguna cuenta**, así que no se puede iniciar sesión hasta ejecutar `pnpm auth:bootstrap` (§5) con una persona titular presente; para usar `direccion`/`admin_tecnico` añade `AUTH_MFA_ENFORCEMENT=deferred` a ese `.env` (§11).

**Qué se probó realmente:** pruebas de componentes con jsdom y `fetch` falso (59; **no** equivalen a un navegador) y **dos pasadas reales en el navegador integrado de la aplicación** contra el entorno aislado (ver §16): login y cookie `HttpOnly` invisible a JavaScript, sesión que sobrevive a recargar, `logout` sin CSRF ⇒ 403, y el flujo completo crear cuenta → asignar rol → solicitar activación → verificar con código → elegir contraseña → iniciar sesión. No es una suite automatizada de navegador (E2E) y no cubre HTTPS ni cookies `__Host-`.

### 9.6 Activación de cuentas por reclamo en dos partes (implementada: `src/modules/activation/`)

Flujo (la administración **nunca** ve el secreto ni la contraseña, y no puede activar por sí sola):

1. **Titular** (`/activar`, sin sesión): su navegador genera un secreto de 256 bits (`crypto.getRandomValues`), calcula `secretHash` = SHA-256 en base64url y envía **solo** `{ email, secretHash }` a `POST /auth/activation/request`. El secreto vive únicamente en la memoria de esa página (no se guarda en `localStorage`, `sessionStorage`, URL ni cookies). Su pantalla muestra un **código** `XXXXX-XXXXX` (50 bits del hash).
2. **Autoridad del mismo dominio** (panel de personal → «Solicitudes de activación», con sesión, CSRF y puerta de MFA): verifica la identidad **en persona** y **teclea el código que lee en la pantalla de la persona** (el listado no lo muestra). `POST /admin/activation-requests/:id/approve { code, verificationMethod }`. El servidor comprueba que el código corresponde a esa solicitud; la autoridad no puede aportar ni sustituir el hash (el trigger lo hace inmutable).
3. **Titular**: `POST /auth/activation/status { secretHash }` (consulta por hash, sin enviar el secreto) hasta que esté `authorized`; luego `POST /auth/activation/complete { secret, newPassword }`. En **una transacción** se bloquea la fila del token, se consume (un solo uso) y la cuenta pasa de `pending` a `active` con el hash Argon2id de **su** contraseña (el trigger exige que ambas cosas ocurran en la misma transacción). **No se abre sesión**: la persona inicia sesión con la contraseña que acaba de elegir.

| Endpoint                                      | Acceso                                    | Notas                                                                                                                                                            |
| --------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/activation/request`               | Público + Origin; límites por IP y correo | 202 idéntico exista o no la cuenta (o sea activa); solo una cuenta **pendiente** recibe la solicitud; TTL 30 min; reemplaza una solicitud previa **sin aprobar** |
| `POST /auth/activation/status`                | Público + Origin                          | `waiting`, `authorized`, `expired` o `unknown` (usado, cancelado, inexistente: indistinguibles)                                                                  |
| `POST /auth/activation/complete`              | Público + Origin; límite de fallos por IP | Generico `ACTIVATION_INVALID` ante cualquier fallo; `PASSWORD_POLICY` (solo motivos) **sin consumir** el token; 204 sin cookie                                   |
| `GET /admin/activation-requests`              | `users:read` + `users:manage_<d>`         | Solicitudes de cuentas pendientes de los dominios que administra (`requested`, `authorized`, `expired`), sin código ni hash                                      |
| `POST /admin/activation-requests/:id/approve` | igual + CSRF                              | Código + `in_person_id`/`in_person_known`; doble aprobación simultánea ⇒ una (409); `activation.authorized` auditada                                             |
| `POST /admin/activation-requests/:id/cancel`  | igual + CSRF                              | Cancela una solicitud vencida, huérfana o ya aprobada (el titular pudo cerrar el navegador) para que inicie otra; `activation.cancelled`                         |

**Controles contra suplantación** (cada uno con prueba): solo cuentas pendientes; solicitud ligada a la cuenta y al propósito `invite`; aprobación solo por una autoridad **activa, del mismo dominio y distinta de la cuenta** (trigger + CHECK, y 404 desde la API); el código evita aprobar una solicitud ajena o inventada; el hash del token es inmutable (ni la autoridad ni el propietario pueden cambiarlo); el token caduca (30 min) y es de un solo uso (8 finalizaciones simultáneas ⇒ 1); **una solicitud vigente —aprobada o no— NO se reemplaza repitiendo la petición pública con el correo** (10 peticiones simultáneas ⇒ una; la cuenta se bloquea durante la comprobación) y solo se libera por caducidad o porque una autoridad la **cancela** (procedimiento autorizado de reinicio); límites de intentos antes de cualquier trabajo costoso; auditoría `activation.requested|authorized|completed|cancelled` y `authz.denied` **sin secretos**. **Control dual:** ninguna autoridad aprueba la activación de una cuenta **que ella misma creó** (cualquier cuenta, privilegiada o no): lo hace otra autoridad del dominio. La interfaz lo avisa (`createdByActor`).

**Riesgos residuales** (no eliminables sin un canal verificable): (1) dos autoridades deshonestas pueden ponerse de acuerdo (una crea, la otra aprueba) para activar una cuenta a nombre de alguien ausente: queda auditado con autores, IP y hora; (2) quien conozca el correo de una cuenta pendiente puede **ocupar durante 30 minutos** la única solicitud vigente (ya no puede reemplazar la de otra persona, pero la persona legítima tendría que esperar o pedir a una autoridad que la cancele; el límite por correo —5 por ventana— acota la repetición); (3) el control dual es de aplicación y la dispensa vive en `audit_events`: quien controle las credenciales de la API o de la base podría falsificarlos (techo de confianza de cualquier control en datos); (4) las cuentas con correo `personal` no pueden activarse todavía (falta verificar el correo).

#### Procedimiento excepcional: incorporar a la SEGUNDA autoridad de un dominio

Con una sola autoridad nadie puede aprobar activaciones (la regla anterior), así que la segunda autoridad se incorpora con una **dispensa** que **no existe por HTTP**: la concede el propietario del esquema desde la consola (`pnpm auth:second-authority -- --email <correo> --acta "<referencia>" [--hours 24]`; identidad del migrador, doble confirmación reescribiendo el acta).

1. Requisitos (todos verificados por el código): cuenta **pendiente** con un rol de **autoridad** ya asignado por la autoridad existente; el dominio tiene **exactamente una** autoridad activa (con cero corresponde `recovery`; con dos, aprueba la otra); acta de 3–200 caracteres; vigencia ≤ 72 h (24 h por defecto).
2. Efecto: **una sola vez**, quien creó la cuenta puede aprobar su activación presencial (la persona sigue eligiendo su contraseña y la autoridad sigue tecleando el código de su pantalla). Se audita `activation.waiver_granted` (acta, caducidad, sin actor de sesión) y `activation.waiver_used` (autoridad que aprobó). Caduca y se consume; si la solicitud se cancela hace falta otra dispensa.
3. Una vez activa la segunda autoridad, las dos se aprueban entre sí sin dispensa; la dispensa deja de ser aplicable (hay dos autoridades).
4. **Estado por dominio:** `technical` habilitado; **`school` BLOQUEADO**. Falta la decisión institucional: quién firma la autorización, qué documento la respalda, quién custodia el acta y quién ejecuta la consola (**D-ESC/D-DUAL**). Desbloquearlo es un cambio de código (`SECOND_AUTHORITY_PROCEDURES`) revisado junto con ese procedimiento. El bootstrap escolar real sigue igualmente bloqueado.
5. Probado en PGlite y en el clúster desechable con dos autoridades ficticias (`pnpm dev:sandbox` trae una segunda autoridad escolar ficticia como fixture aislada). No se ejecutó nada en `eta15_dev`.

### 9.7 Política de contraseñas (`shared-contracts/src/password-policy.ts`)

Misma función en servidor (autoridad) y cliente (orientación). Argon2id (§9.1) con NFKC. **Mínimo 12 y máximo 128 caracteres Unicode** (una frase larga es válida, sin reglas de mayúsculas/números/símbolos). Se rechazan: contraseñas comunes (lista local de 12+ caracteres), una palabra común con relleno de dígitos o símbolos («Password123456», «Contraseña2026!!»), el correo o el nombre de la persona, un solo carácter repetido, patrones repetidos y secuencias. Los motivos se devuelven como códigos; **nunca** se repite ni se registra la contraseña. Aplica a la activación y al bootstrap. **No** se consulta ningún servicio de contraseñas filtradas (sin justificación todavía; decisión D4/D-PWD): la lista local es una barrera mínima. No hay contraseñas por defecto en ninguna parte.

### 9.8 Panel de personal y pantalla de activación (`apps/web-admin`)

- **`/personal`** (visible solo si los permisos efectivos de `/auth/me` incluyen `users:read` y `users:manage_<d>`; **ocultar no autoriza**: el servidor revalida cada llamada): lista paginada con búsqueda (retraso de 300 ms, mínimo 2 caracteres), filtros de estado y dominio (si administra más de uno), detalle de la cuenta, **crear cuenta pendiente** (sin campo de contraseña), asignar y revocar roles permitidos, deshabilitar (diálogos de confirmación para lo sensible; no se ofrece sobre la propia cuenta), estado de activación y la pestaña **Solicitudes de activación** (verificar identidad con código y método, cancelar). Estados de carga, vacíos y errores comprensibles; responsive y accesible (etiquetas, `role="dialog"` con foco atrapado, `aria-live`).
- **`/activar`** (pública): inicio → código en pantalla y espera (consulta cada 4 s) → contraseña propia con confirmación y orientación de la política → «¡Tu cuenta está activa!» → login. Si se cierra o recarga la página, el secreto se pierde y se empieza de nuevo (una autoridad puede cancelar la solicitud previa); no existe ningún mecanismo de recuperación.

## 10. Auditoría y roles de PostgreSQL

La auditoría **no es absolutamente inmutable**. Protección real: sin UPDATE/DELETE/TRUNCATE para quien no sea propietario (trigger `ENABLE ALWAYS`, que sigue disparando aun con `session_replication_role = replica`; el rol de la API no puede alterar ni quitar el trigger: _must be owner_). Límite probado: **el propietario o un superusuario puede deshabilitar el trigger y modificar eventos**. Mitigaciones: separar roles (abajo), custodiar la credencial del propietario, exportar la auditoría a un registro externo y, más adelante, encadenar hashes.

**Funciones SQL (revisión previa a aplicar)**: son 20 (1 de la migración 0001 y 19 nuevas); ninguna es `SECURITY DEFINER`, todas fijan `search_path = pg_catalog, pg_temp` y califican `public.`. PostgreSQL concede `EXECUTE` a `PUBLIC` por defecto, así que 0005 lo **revoca de todas** (bucle limitado al esquema `public`) y termina con una aserción que **hace fallar la migración** si queda alguna abierta, `SECURITY DEFINER` o sin `search_path` fijo (probado). Al separar roles bastará `GRANT EXECUTE` de los tres ayudantes `auth_*` al rol de la API; sin eso la API no puede operar (probado). Las funciones de trigger no requieren `EXECUTE` al dispararse. **Hallazgo**: un rol con el privilegio de tabla `TRIGGER` puede adjuntar un trigger propio (con función temporal) que reescribe `granted_by` antes de las guardas y se autoasciende a `direccion` (**demostrado** en `auth-functions.test.ts`). Por eso el rol de la API **nunca** recibe `TRIGGER` (ni `ALL`), y debe verificarse con `tools/db/04-audit-privileges.sql`.

**La futura API necesitará un rol de ejecución distinto del propietario** (trabajo de la ADR 0003; **no se cambió ningún rol real**). Matriz propuesta (se prueba hoy con un rol simulado con _todos_ los privilegios de tabla como peor caso):

| Rol           | Atributos                                                                                                             | Privilegios                                                                                                                                                                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eta15_owner` | Propietario de tablas y funciones; solo migraciones y consola (bootstrap/recovery); sin acceso desde la red de la API | DDL, todo                                                                                                                                                                                                                                                                                                              |
| `eta15_api`   | LOGIN, **no** propietario y **no** miembro de `eta15_owner`                                                           | SELECT en todo; INSERT en `users`, `user_roles`, `sessions`, `auth_tokens`, `audit_events`; UPDATE en `users`, `user_roles`, `sessions`, `auth_tokens`; DELETE solo en `sessions`/`auth_tokens` (purga); `role_permissions` **solo SELECT** (aplicado 2026-10-26); sin TRUNCATE ni DDL; idealmente UPDATE por columnas |

## 11. MFA: pospuesto por decisión del proyecto (MVP)

**Decisión (2026-10-26):** MFA/TOTP queda **pospuesto**; no se implementa TOTP, códigos temporales ni bibliotecas MFA en esta etapa. Se prioriza administración de usuarios, inicio de sesión con correo y contraseña, roles y permisos, gestión escolar, asistencia y control de acceso. Los roles `direccion` y `admin_tecnico` siguen **marcados** como que exigen MFA (`roles.requires_mfa = true`, sembrado en la migración 0004 y sin cambios en la base real); lo que cambia es **si el servidor lo impone**.

### 11.1 Dónde se exige hoy (inventario)

| Capa                               | Qué hace                                                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Datos (`roles.requires_mfa`)       | Bandera por rol; solo el propietario del esquema la cambia (`eta15_api` no tiene UPDATE) y cada cambio queda en `audit_events` (`role.updated`). No hay CHECK/trigger que la use. |
| Datos (`sessions.mfa_verified_at`) | Momento de verificación del segundo factor; nulo si no hubo.                                                                                                                      |
| Servicio de sesiones               | `create`/`verify` aplican la política `mfaEnforcement` (`required` o `deferred`).                                                                                                 |
| Login (`auth-service`/rutas)       | Con `required`: 403 `MFA_REQUIRED` y ninguna sesión. Con `deferred`: sesión normal.                                                                                               |
| Contrato `GET /auth/me`            | `mfa: { required, enforced, verified }` para que cliente y guardas futuros conozcan el estado real.                                                                               |

### 11.2 Política del MVP: `AUTH_MFA_ENFORCEMENT`

Ajuste explícito de `apps/api/.env` (documentado también en `.env.example`), **no** una migración:

| Valor                | Efecto                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `required` (defecto) | Comportamiento seguro: `direccion` y `admin_tecnico` **no pueden entrar** (no existe segundo factor).                                                                                                                                                                    |
| `deferred`           | Entran con correo y contraseña. La sesión queda **sin** `mfa_verified_at` (nunca se simula un factor), cada alta se audita (`auth.session_without_mfa` con rol e IP, sin secretos), y la API avisa al arrancar. Volver a `required` invalida de inmediato esas sesiones. |

Condiciones que la propia API impone a `deferred` (falla el arranque con `Configuracion invalida` si no se cumplen): `NODE_ENV` distinto de `production`, `HOST` y `DB_HOST` en loopback. No hay otra forma de activarlo: ni bandera oculta, ni cabecera, ni usuario de prueba.

**Por qué configuración y no una migración 0006 que ponga `requires_mfa = false`:** un dato cambiado viaja con cada `migrate`, restauración o copia hacia otros entornos (incluido producción) sin que nadie lo recuerde, y borra la declaración institucional de que esos roles exigen MFA. La configuración, en cambio, es local, el arranque la rechaza fuera del desarrollo y los datos conservan la política objetivo. Por eso **no hay migración 0006** y la base real no cambia; el comportamiento descrito funciona en cuanto se añade la línea al `.env` local.

**Lo que NO cambia con el diferimiento:** autorización en el backend por permiso y alcance, separación de dominios `school`/`technical` (claves foráneas compuestas), imposibilidad de autoasignarse roles (triggers + privilegios de `eta15_api`; la API tampoco puede editar `roles`), CSRF y comprobación de origen, límites de intentos, caducidades y tope de sesiones, revocaciones, y la auditoría de cambios de roles y de cuentas.

### 11.3 Condiciones antes de cualquier despliegue o dato real

La excepción es **solo de desarrollo local con datos sintéticos**. Antes de usar datos personales reales de alumnos o de desplegar fuera de la máquina de desarrollo deben cumplirse, como mínimo:

1. Revisión institucional de la política de MFA y de los controles de la plataforma (decisión D-MFA, §18). Mientras no exista, `AUTH_MFA_ENFORCEMENT` permanece en `required` (único valor que el arranque admite en producción).
2. MFA implementado y probado para `admin_tecnico` y `direccion` (TOTP RFC 6238 con biblioteca mantenida, secretos cifrados en reposo, códigos de respaldo con hash, sin función que desactive un factor, reinicio presencial con control dual).
3. Bootstrap controlado con acta, rotación de las contraseñas de los roles de PostgreSQL y revisión de los riesgos de §14 y de `roles-postgresql.md`.
4. Revisión de las sesiones creadas sin MFA: las filas `auth.session_without_mfa` de `audit_events` deben haberse revisado y no debe quedar ninguna cuenta real operando bajo la excepción.

### 11.4 Preparado para MFA futuro (sin implementarlo)

`roles.requires_mfa`, `sessions.mfa_verified_at`, `createWithin({ mfaVerified })`, el estado `mfa` del contrato y la política `required` ya existen. Para implementar MFA bastará: (a) endpoints de enrolamiento y de desafío (el login devolverá un estado de desafío en vez del 403 y la sesión solo se emitirá o se marcará con `mfa_verified_at` tras verificar el factor), (b) quitar `AUTH_MFA_ENFORCEMENT=deferred` de los entornos, (c) añadir un guarda `requireMfa` en rutas de autoridad que use `request.auth.mfa`. No se requieren cambios de esquema.

## 12. Matriz de permisos

`✓` todos · `G` grupos asignados · `B` datos básicos · `—` ninguno · `(A)` autoridad.

(¹) Desde la migración **0006** (aplicada en `eta15_dev` el 2026-10-26) la administración del catálogo es el permiso escolar `catalog:manage_school`, solo de `direccion`; `admin_tecnico` pierde `catalog:manage` (que queda definido sin asignar) y `catalog:read` (el catálogo no necesita permisos técnicos); prefectura, trabajo social y control de acceso pierden `catalog:read` hasta que exista requerimiento (ver [modelo-catalogo-escolar.md](modelo-catalogo-escolar.md)). La tabla muestra el estado vigente tras 0006.

| Permiso                                                                           | prefectura | trabajo_social | control_acceso | direccion | admin_tecnico |
| --------------------------------------------------------------------------------- | :--------: | :------------: | :------------: | :-------: | :-----------: |
| `catalog:read`                                                                    |     —      |       —        |       —        |     ✓     |       —       |
| `roles:read` · `users:read` (sin datos escolares)                                 |     —      |       —        |       —        |     ✓     |       ✓       |
| `catalog:manage_school` (¹)                                                       |     —      |       —        |       —        |     ✓     |       —       |
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

Prefijo `/v1` (`/api/v1/...` en el navegador) para el resto; errores con el formato común; mutaciones con `X-CSRF-Token`. **Implementado (sin `/v1`): `login`, `logout`, `me` y `csrf` (§9.3).** `PUT …/roles/:key/permissions` exigirá volver a conceder INSERT/DELETE sobre `role_permissions` a `eta15_api`, con revisión de seguridad propia.

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
| 5. Endpoints      | login/logout/me/solicitudes de credencial                        | 401 idéntico; 429; sin secretos                                                                                     | login/logout/me/csrf **hechos**; solicitudes de credencial pendientes                               |
| 6. Administración | Cuentas, roles, autorizaciones, auditoría                        | Pruebas de escalamiento **por HTTP**                                                                                | Reglas hechas; endpoints pendientes                                                                 |
| 7. MFA            | TOTP                                                             | Obligatorio por rol                                                                                                 | **Pospuesto** (decisión del MVP, §11); obligatorio **antes de datos reales**                        |
| 8. Frontend       | `AuthProvider`, login, guards (solo UX)                          | Flujo completo                                                                                                      | Pendiente                                                                                           |
| 9. Cierre         | Revisión ASVS 5.0.0 V6/V7/V8 con evidencia                       | Lista firmada; integración real                                                                                     | Pendiente                                                                                           |

## 16. Pruebas: qué demuestra cada tipo

| Tipo                                                                                                              | Archivos                                                                                                                                                      | Qué demuestra / límites                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unitarias/contractuales (sin BD)                                                                                  | `access-control`, `resource-authorization`, `session-policy`, `drizzle-guard`                                                                                 | Reglas puras y **contratos** que los endpoints futuros deben cumplir; no prueban endpoints                                                                                                                                                                                                                                                                                                                                 |
| De esquema en PGlite (PG 18.6, memoria)                                                                           | `auth-schema`, `auth-privileges`, `auth-recovery`, `auth-seed`                                                                                                | Constraints y triggers, con un rol de API **simulado no propietario y con todos los privilegios**                                                                                                                                                                                                                                                                                                                          |
| Concurrencia real (PG 18.0, clúster desechable)                                                                   | `test/pgtemp/concurrency.pg.test.ts` (`pnpm test:pg-temp`)                                                                                                    | Bootstrap simultáneo, consumo paralelo de tokens, concesión vs revocación, tope de sesiones, protección frente al rol de la API                                                                                                                                                                                                                                                                                            |
| Servicios, HTTP, administración, activación y bootstrap (PGlite y clúster desechable con `eta15_api`/`eta15_app`) | `password`, `password-policy`, `auth-session-service`, `auth-http`, `admin-http`, `activation` (`test/helpers/*-suite.ts`), `bootstrap`, `guards`, `pgtemp/*` | Argon2id/PHC, sesiones, **45 casos de `/auth`**, **/admin y activación** (también con los privilegios exactos de `eta15_api` y concurrencia real: aprobaciones, finalizaciones y cancelaciones simultáneas; titulares que se quitan el rol a la vez), **10 de bootstrap**, política de contraseñas, MFA diferido, escalamiento en la base, sin secretos en respuestas, logs ni auditoría                                   |
| Componentes React (`apps/web-admin`, jsdom + `fetch` falso)                                                       | `features/auth`, `features/personal`, `features/activation`                                                                                                   | **60 casos**: login, rutas protegidas, panel de personal (permisos efectivos, filtros, paginación, confirmaciones, CSRF), solicitudes de activación y pantalla de activación (hash/código/secreto, política, estados). **No son pruebas de navegador real**                                                                                                                                                                |
| Navegador real (a mano, dos pasadas)                                                                              | navegador integrado de la aplicación contra `pnpm dev:sandbox`                                                                                                | (1) Login/cookie/CSRF/administración. (2) **Flujo completo** (antes de las reglas de control dual): Dirección crea una cuenta y le asigna un rol desde el panel, la persona inicia la activación en otra pestaña, un código erróneo es rechazado, la autoridad verifica con el código correcto, la persona elige su contraseña, inicia sesión y no ve la administración (`/admin/users` ⇒ 403). No automatizado, sin HTTPS |
| Integración con `eta15_dev` (`test:integration`)                                                                  | `test/integration/*`                                                                                                                                          | Identidades, privilegios efectivos de `eta15_api` (incl. `role_permissions` de solo lectura, SQLSTATE 42501) y semilla; **sin crear usuarios** (todo lo que escribe va en `ROLLBACK`)                                                                                                                                                                                                                                      |

No cubierto: MFA (inexistente), rendimiento/carga, rate limiting con varias instancias, navegador real (cookies `__Host-` con HTTPS se prueban por atributos, no en un navegador), recuperación/activación por HTTP, administración de cuentas y roles, y las rutas de datos escolares (aún no existen).

## 17. Mapeo con ASVS 5.0.0 (capítulos)

| Capítulo             | Cubierto por diseño/esquema                                                                                                                                           | Pendiente                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| V6 Autenticación     | Argon2id y política de contraseñas (diseño), mismo coste y mensaje en fallos (diseño), activación/recuperación sin que la autoridad conozca secretos, MFA planificado | Implementación, MFA, rate limit, lista de contraseñas comunes |
| V7 Sesiones          | Token opaco hasheado, caducidad absoluta/inactividad por rol, tope y revocación impuestos en BD, rotación en login (diseño)                                           | Cookie/CSRF, renovación, cierre de sesión                     |
| V8 Autorización      | Denegar por defecto, separación de funciones, dominios, alcance por grupo y campo (contratos), autorización en backend                                                | Guards en rutas y pruebas por HTTP                            |
| Registro y auditoría | `audit_events` solo inserción (con límites), atribución, sin secretos                                                                                                 | Servicio de auditoría, exportación externa                    |

## 18. Decisiones pendientes que requieren autorización institucional

| #      | Decisión                                                                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1     | Retención de auditoría y de sesiones                                                                                                                |
| D-MFA  | Política institucional de MFA y condiciones para salir del desarrollo local con datos reales (§11.3)                                                |
| D2     | Supuestos de Dirección marcados (*) en la matriz                                                                                                    |
| D3     | Canal de correo (hoy: ninguno; solo procedimiento presencial)                                                                                       |
| D4     | Verificación de contraseñas filtradas (HIBP, sale a internet)                                                                                       |
| D5     | Quién ejecuta bootstrap/recovery, y formato y custodia del acta                                                                                     |
| D6     | Procedimiento y control dual para reiniciar el MFA de una cuenta privilegiada                                                                       |
| D-ESC  | Procedimiento verificable para acreditar a la primera autoridad escolar (hoy el bootstrap `school` está BLOQUEADO en el código)                     |
| D-DUAL | Quién autoriza, con qué documento y quién ejecuta la dispensa para incorporar a la segunda autoridad **escolar** (hoy bloqueada en el código; §9.6) |
| D-PWD  | Alcance de la política de contraseñas: longitud mínima (hoy 12), lista de contraseñas filtradas (D4) y caducidad (no se impone)                     |
| D7     | Un suplente de Dirección (segundo titular) para no depender de una sola persona                                                                     |
| D8     | Cuándo separar los roles de PostgreSQL (`eta15_owner`/`eta15_api`): condiciona que las guardas “solo propietario” protejan de verdad                |
